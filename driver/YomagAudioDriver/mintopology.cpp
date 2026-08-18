#include "common.h"
#include "mintopology.h"

NTSTATUS CreateMiniportTopology(
    _Out_ PUNKNOWN* Unknown,
    _In_ REFCLSID,
    _In_opt_ PUNKNOWN UnknownOuter,
    _In_ POOL_TYPE PoolType)
{
    PAGED_CODE();
    STD_CREATE_BODY_(CMiniportTopology, Unknown, UnknownOuter, PoolType, PMINIPORTTOPOLOGY);
}

CMiniportTopology::~CMiniportTopology()
{
    if (m_Port)
    {
        m_Port->Release();
        m_Port = nullptr;
    }
}

STDMETHODIMP_(NTSTATUS) CMiniportTopology::NonDelegatingQueryInterface(REFIID Interface, PVOID* Object)
{
    if (IsEqualGUIDAligned(Interface, IID_IUnknown))
    {
        *Object = PVOID(PUNKNOWN(PMINIPORTTOPOLOGY(this)));
    }
    else if (IsEqualGUIDAligned(Interface, IID_IMiniport))
    {
        *Object = PVOID(PMINIPORT(this));
    }
    else if (IsEqualGUIDAligned(Interface, IID_IMiniportTopology))
    {
        *Object = PVOID(PMINIPORTTOPOLOGY(this));
    }
    else
    {
        *Object = NULL;
        return STATUS_NOT_SUPPORTED;
    }

    PUNKNOWN(*Object)->AddRef();
    return STATUS_SUCCESS;
}

STDMETHODIMP_(NTSTATUS) CMiniportTopology::Init(
    _In_ PUNKNOWN,
    _In_ PRESOURCELIST,
    _In_ PPORTTOPOLOGY Port)
{
    PAGED_CODE();

    m_Port = Port;
    m_Port->AddRef();
    return STATUS_SUCCESS;
}

// Generic "analog" data range: bridge pins represent the physical/analog
// domain, not a specific PCM format, so this is the standard minimal range
// used for topology connector pins rather than a WAVEFORMATEX-based one.
static KSDATARANGE PinDataRangeBridge =
{
    { sizeof(KSDATARANGE), 0, 0, 0,
      STATICGUIDOF(KSDATAFORMAT_TYPE_AUDIO),
      STATICGUIDOF(KSDATAFORMAT_SUBTYPE_ANALOG),
      STATICGUIDOF(KSDATAFORMAT_SPECIFIER_NONE) }
};

static PKSDATARANGE PinDataRangePointersBridge[] =
{
    &PinDataRangeBridge
};

// AudioEndpointBuilder (see
// https://learn.microsoft.com/windows-hardware/drivers/audio/audio-endpoint-builder-algorithm)
// creates an endpoint for every UNCONNECTED bridge pin whose Category is a
// KSNODETYPE_* GUID, then requires a traceable path from that pin back to a
// "host pin" (KSPIN_COMMUNICATION_SINK/BOTH) on the wave filter. So each
// direction needs two pins here, not one: an internal-facing pin
// (Category=KSCATEGORY_AUDIO) that PcRegisterPhysicalConnection wires
// across to the wave filter's own bridge pin (see driver.cpp), connected
// via PCCONNECTION_DESCRIPTOR to the true external KSNODETYPE_SPEAKER/
// MICROPHONE bridge pin, which must stay otherwise unconnected for
// AudioEndpointBuilder to recognize it as an endpoint at all.
static PCPIN_DESCRIPTOR MiniportPins[] =
{
    // Pin 0: internal render pin - PcRegisterPhysicalConnection target for
    // the wave filter's render bridge pin.
    {
        1, 1, 1, NULL,
        {
            0, NULL,
            0, NULL,
            SIZEOF_ARRAY(PinDataRangePointersBridge), PinDataRangePointersBridge,
            KSPIN_DATAFLOW_IN,
            KSPIN_COMMUNICATION_NONE,
            &KSCATEGORY_AUDIO,
            NULL,
            0
        }
    },
    // Pin 1: speaker (render) bridge - the actual external endpoint pin,
    // left unconnected to any cross-filter physical connection.
    {
        1, 1, 1, NULL,
        {
            0, NULL,
            0, NULL,
            SIZEOF_ARRAY(PinDataRangePointersBridge), PinDataRangePointersBridge,
            KSPIN_DATAFLOW_OUT,
            KSPIN_COMMUNICATION_NONE,
            &KSNODETYPE_SPEAKER,
            NULL,
            0
        }
    },
    // Pin 2: microphone (capture) bridge - the actual external endpoint
    // pin, left unconnected to any cross-filter physical connection.
    {
        1, 1, 1, NULL,
        {
            0, NULL,
            0, NULL,
            SIZEOF_ARRAY(PinDataRangePointersBridge), PinDataRangePointersBridge,
            KSPIN_DATAFLOW_IN,
            KSPIN_COMMUNICATION_NONE,
            &KSNODETYPE_MICROPHONE,
            NULL,
            0
        }
    },
    // Pin 3: internal capture pin - PcRegisterPhysicalConnection source
    // toward the wave filter's capture bridge pin.
    {
        1, 1, 1, NULL,
        {
            0, NULL,
            0, NULL,
            SIZEOF_ARRAY(PinDataRangePointersBridge), PinDataRangePointersBridge,
            KSPIN_DATAFLOW_OUT,
            KSPIN_COMMUNICATION_NONE,
            &KSCATEGORY_AUDIO,
            NULL,
            0
        }
    }
};

static PCCONNECTION_DESCRIPTOR MiniportConnections[] =
{
    // Render: internal pin 0 -> external speaker bridge pin 1.
    { PCFILTER_NODE, 0, PCFILTER_NODE, 1 },
    // Capture: external mic bridge pin 2 -> internal pin 3.
    { PCFILTER_NODE, 2, PCFILTER_NODE, 3 }
};

static PCFILTER_DESCRIPTOR MiniportFilterDescriptor =
{
    0,
    NULL,
    sizeof(PCPIN_DESCRIPTOR),
    SIZEOF_ARRAY(MiniportPins),
    MiniportPins,
    0, 0, NULL,
    SIZEOF_ARRAY(MiniportConnections), MiniportConnections,
    0, NULL
};

STDMETHODIMP_(NTSTATUS) CMiniportTopology::GetDescription(_Out_ PPCFILTER_DESCRIPTOR* Description)
{
    *Description = &MiniportFilterDescriptor;
    return STATUS_SUCCESS;
}

STDMETHODIMP_(NTSTATUS) CMiniportTopology::DataRangeIntersection(
    _In_ ULONG,
    _In_ PKSDATARANGE DataRange,
    _In_ PKSDATARANGE,
    _In_ ULONG OutputBufferLength,
    _Out_writes_bytes_to_opt_(OutputBufferLength, *ResultantFormatLength) PVOID ResultantFormat,
    _Out_ PULONG ResultantFormatLength)
{
    if (OutputBufferLength == 0)
    {
        *ResultantFormatLength = sizeof(KSDATARANGE);
        return STATUS_BUFFER_OVERFLOW;
    }
    if (OutputBufferLength < sizeof(KSDATARANGE))
    {
        return STATUS_BUFFER_TOO_SMALL;
    }

    RtlCopyMemory(ResultantFormat, DataRange, sizeof(KSDATARANGE));
    *ResultantFormatLength = sizeof(KSDATARANGE);
    return STATUS_SUCCESS;
}
