#include "common.h"
#include "minwavecyclic.h"

// -----------------------------------------------------------------------
// Filter/pin description (shared by all instances - GetDescription just
// hands back a pointer to these statics).
// -----------------------------------------------------------------------

static KSDATARANGE_AUDIO PinDataRangesStream[] =
{
    {
        { sizeof(KSDATARANGE_AUDIO), 0, 0, 0,
          STATICGUIDOF(KSDATAFORMAT_TYPE_AUDIO),
          STATICGUIDOF(KSDATAFORMAT_SUBTYPE_PCM),
          STATICGUIDOF(KSDATAFORMAT_SPECIFIER_WAVEFORMATEX) },
        YOMAG_CHANNELS,
        YOMAG_BITS_PER_SAMPLE, YOMAG_BITS_PER_SAMPLE,
        YOMAG_SAMPLES_PER_SEC, YOMAG_SAMPLES_PER_SEC
    }
};

static PKSDATARANGE PinDataRangePointersStream[] =
{
    PKSDATARANGE(&PinDataRangesStream[0])
};

// Generic "analog" bridge data range for the two non-streaming bridge pins
// below - same reasoning as mintopology.cpp's copy: a bridge pin represents
// the bare physical/topology-graph connection, not a specific PCM format.
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

// AudioEndpointBuilder requires a traceable path from the topology filter's
// external bridge pin back to a "host pin" (KSPIN_COMMUNICATION_SINK/BOTH)
// on this filter - see mintopology.cpp for the full reasoning. That means
// each direction needs its own non-streaming bridge pin here too, distinct
// from the app-facing streaming pin, wired to it via PCCONNECTION_DESCRIPTOR
// and out to the topology filter via PcRegisterPhysicalConnection (driver.cpp).
static PCPIN_DESCRIPTOR MiniportWavePins[] =
{
    // Pin 0: render streaming (sink, host pin) - WASAPI/apps write PCM here.
    {
        1, 1, 1, NULL,
        {
            0, NULL, 0, NULL,
            SIZEOF_ARRAY(PinDataRangePointersStream), PinDataRangePointersStream,
            KSPIN_DATAFLOW_IN,
            KSPIN_COMMUNICATION_SINK,
            NULL, NULL, 0
        }
    },
    // Pin 1: render bridge - connects out to the topology filter's internal
    // render pin (see driver.cpp).
    {
        1, 1, 1, NULL,
        {
            0, NULL, 0, NULL,
            SIZEOF_ARRAY(PinDataRangePointersBridge), PinDataRangePointersBridge,
            KSPIN_DATAFLOW_OUT,
            KSPIN_COMMUNICATION_NONE,
            &KSCATEGORY_AUDIO,
            NULL,
            0
        }
    },
    // Pin 2: capture streaming (sink, host pin) - WASAPI/apps read PCM
    // from here.
    {
        1, 1, 1, NULL,
        {
            0, NULL, 0, NULL,
            SIZEOF_ARRAY(PinDataRangePointersStream), PinDataRangePointersStream,
            KSPIN_DATAFLOW_OUT,
            KSPIN_COMMUNICATION_SINK,
            NULL, NULL, 0
        }
    },
    // Pin 3: capture bridge - receives the connection from the topology
    // filter's internal capture pin (see driver.cpp).
    {
        1, 1, 1, NULL,
        {
            0, NULL, 0, NULL,
            SIZEOF_ARRAY(PinDataRangePointersBridge), PinDataRangePointersBridge,
            KSPIN_DATAFLOW_IN,
            KSPIN_COMMUNICATION_NONE,
            &KSCATEGORY_AUDIO,
            NULL,
            0
        }
    }
};

static PCCONNECTION_DESCRIPTOR MiniportWaveConnections[] =
{
    // Render: streaming pin 0 -> bridge pin 1.
    { PCFILTER_NODE, 0, PCFILTER_NODE, 1 },
    // Capture: bridge pin 3 -> streaming pin 2.
    { PCFILTER_NODE, 3, PCFILTER_NODE, 2 }
};

static PCFILTER_DESCRIPTOR MiniportWaveFilterDescriptor =
{
    0,
    NULL,
    sizeof(PCPIN_DESCRIPTOR),
    SIZEOF_ARRAY(MiniportWavePins),
    MiniportWavePins,
    0, 0, NULL,
    SIZEOF_ARRAY(MiniportWaveConnections), MiniportWaveConnections,
    0, NULL
};

static bool IsSupportedFormat(_In_ PKSDATAFORMAT DataFormat)
{
    if (DataFormat->FormatSize < sizeof(KSDATAFORMAT_WAVEFORMATEX))
    {
        return false;
    }

    PKSDATAFORMAT_WAVEFORMATEX format = (PKSDATAFORMAT_WAVEFORMATEX)DataFormat;
    PWAVEFORMATEX wfx = &format->WaveFormatEx;

    return wfx->wFormatTag == WAVE_FORMAT_PCM
        && wfx->nChannels == YOMAG_CHANNELS
        && wfx->nSamplesPerSec == YOMAG_SAMPLES_PER_SEC
        && wfx->wBitsPerSample == YOMAG_BITS_PER_SAMPLE;
}

// -----------------------------------------------------------------------
// CMiniportWaveCyclic
// -----------------------------------------------------------------------

NTSTATUS CreateMiniportWaveCyclic(
    _Out_ PUNKNOWN* Unknown,
    _In_ REFCLSID,
    _In_opt_ PUNKNOWN UnknownOuter,
    _In_ POOL_TYPE PoolType)
{
    PAGED_CODE();
    STD_CREATE_BODY_(CMiniportWaveCyclic, Unknown, UnknownOuter, PoolType, PMINIPORTWAVECYCLIC);
}

CMiniportWaveCyclic::~CMiniportWaveCyclic()
{
    if (m_Port)
    {
        m_Port->Release();
        m_Port = nullptr;
    }
}

STDMETHODIMP_(NTSTATUS) CMiniportWaveCyclic::NonDelegatingQueryInterface(REFIID Interface, PVOID* Object)
{
    if (IsEqualGUIDAligned(Interface, IID_IUnknown))
    {
        *Object = PVOID(PUNKNOWN(PMINIPORTWAVECYCLIC(this)));
    }
    else if (IsEqualGUIDAligned(Interface, IID_IMiniport))
    {
        *Object = PVOID(PMINIPORT(this));
    }
    else if (IsEqualGUIDAligned(Interface, IID_IMiniportWaveCyclic))
    {
        *Object = PVOID(PMINIPORTWAVECYCLIC(this));
    }
    else
    {
        *Object = NULL;
        return STATUS_NOT_SUPPORTED;
    }

    PUNKNOWN(*Object)->AddRef();
    return STATUS_SUCCESS;
}

STDMETHODIMP_(NTSTATUS) CMiniportWaveCyclic::Init(
    _In_ PUNKNOWN,
    _In_ PRESOURCELIST,
    _In_ PPORTWAVECYCLIC Port)
{
    PAGED_CODE();

    m_Port = Port;
    m_Port->AddRef();

    return m_CableBuffer.Initialize(YOMAG_CABLE_BUFFER_BYTES);
}

STDMETHODIMP_(NTSTATUS) CMiniportWaveCyclic::GetDescription(_Out_ PPCFILTER_DESCRIPTOR* Description)
{
    *Description = &MiniportWaveFilterDescriptor;
    return STATUS_SUCCESS;
}

STDMETHODIMP_(NTSTATUS) CMiniportWaveCyclic::DataRangeIntersection(
    _In_ ULONG,
    _In_ PKSDATARANGE DataRange,
    _In_ PKSDATARANGE,
    _In_ ULONG OutputBufferLength,
    _Out_writes_bytes_to_opt_(OutputBufferLength, *ResultantFormatLength) PVOID ResultantFormat,
    _Out_ PULONG ResultantFormatLength)
{
    if (OutputBufferLength == 0)
    {
        *ResultantFormatLength = sizeof(KSDATAFORMAT_WAVEFORMATEX);
        return STATUS_BUFFER_OVERFLOW;
    }
    if (OutputBufferLength < sizeof(KSDATAFORMAT_WAVEFORMATEX))
    {
        return STATUS_BUFFER_TOO_SMALL;
    }
    UNREFERENCED_PARAMETER(DataRange);

    PKSDATAFORMAT_WAVEFORMATEX result = (PKSDATAFORMAT_WAVEFORMATEX)ResultantFormat;
    RtlZeroMemory(result, sizeof(KSDATAFORMAT_WAVEFORMATEX));
    result->DataFormat.FormatSize = sizeof(KSDATAFORMAT_WAVEFORMATEX);
    result->DataFormat.MajorFormat = KSDATAFORMAT_TYPE_AUDIO;
    result->DataFormat.SubFormat = KSDATAFORMAT_SUBTYPE_PCM;
    result->DataFormat.Specifier = KSDATAFORMAT_SPECIFIER_WAVEFORMATEX;
    result->DataFormat.SampleSize = YOMAG_BLOCK_ALIGN;
    result->WaveFormatEx.wFormatTag = WAVE_FORMAT_PCM;
    result->WaveFormatEx.nChannels = YOMAG_CHANNELS;
    result->WaveFormatEx.nSamplesPerSec = YOMAG_SAMPLES_PER_SEC;
    result->WaveFormatEx.nAvgBytesPerSec = YOMAG_AVG_BYTES_PER_SEC;
    result->WaveFormatEx.nBlockAlign = YOMAG_BLOCK_ALIGN;
    result->WaveFormatEx.wBitsPerSample = YOMAG_BITS_PER_SAMPLE;

    *ResultantFormatLength = sizeof(KSDATAFORMAT_WAVEFORMATEX);
    return STATUS_SUCCESS;
}

STDMETHODIMP_(NTSTATUS) CMiniportWaveCyclic::NewStream(
    _Out_ PMINIPORTWAVECYCLICSTREAM* Stream,
    _In_opt_ PUNKNOWN,
    _In_ POOL_TYPE PoolType,
    _In_ ULONG Pin,
    _In_ BOOLEAN Capture,
    _In_ PKSDATAFORMAT DataFormat,
    _Out_ PDMACHANNEL* DmaChannel,
    _Out_ PSERVICEGROUP* ServiceGroup)
{
    PAGED_CODE();

    // Only the two streaming (host) pins are ever opened as a stream -
    // PortCls never calls NewStream for the bridge pins (1 and 3), those
    // exist purely for the topology filter's physical-connection graph.
    if ((Pin == 0 && Capture) || (Pin == 2 && !Capture) || (Pin != 0 && Pin != 2))
    {
        return STATUS_INVALID_PARAMETER;
    }
    if (!IsSupportedFormat(DataFormat))
    {
        return STATUS_INVALID_PARAMETER;
    }

    CYomagDmaChannel* dmaChannel = new(PoolType) CYomagDmaChannel(NULL);
    if (!dmaChannel)
    {
        return STATUS_INSUFFICIENT_RESOURCES;
    }
    dmaChannel->AddRef();

    NTSTATUS status = dmaChannel->AllocateBuffer(YOMAG_CABLE_BUFFER_BYTES, NULL);
    if (!NT_SUCCESS(status))
    {
        dmaChannel->Release();
        return status;
    }

    CMiniportWaveCyclicStream* stream = new(PoolType) CMiniportWaveCyclicStream(NULL);
    if (!stream)
    {
        dmaChannel->Release();
        return STATUS_INSUFFICIENT_RESOURCES;
    }
    stream->AddRef();

    status = stream->Init(Pin, Capture, dmaChannel, &m_CableBuffer);
    if (!NT_SUCCESS(status))
    {
        stream->Release();
        dmaChannel->Release();
        return status;
    }

    PSERVICEGROUP serviceGroup = NULL;
    status = PcNewServiceGroup(&serviceGroup, NULL);
    if (!NT_SUCCESS(status))
    {
        stream->Release();
        dmaChannel->Release();
        return status;
    }
    serviceGroup->AddMember(PSERVICESINK(stream));

    *Stream = stream;
    *DmaChannel = dmaChannel;
    *ServiceGroup = serviceGroup;

    return STATUS_SUCCESS;
}

// -----------------------------------------------------------------------
// CMiniportWaveCyclicStream
// -----------------------------------------------------------------------

CMiniportWaveCyclicStream::~CMiniportWaveCyclicStream()
{
    if (m_DmaChannel)
    {
        m_DmaChannel->Release();
        m_DmaChannel = nullptr;
    }
}

STDMETHODIMP_(NTSTATUS) CMiniportWaveCyclicStream::NonDelegatingQueryInterface(REFIID Interface, PVOID* Object)
{
    if (IsEqualGUIDAligned(Interface, IID_IUnknown))
    {
        *Object = PVOID(PUNKNOWN(PMINIPORTWAVECYCLICSTREAM(this)));
    }
    else if (IsEqualGUIDAligned(Interface, IID_IMiniportWaveCyclicStream))
    {
        *Object = PVOID(PMINIPORTWAVECYCLICSTREAM(this));
    }
    else if (IsEqualGUIDAligned(Interface, IID_IServiceSink))
    {
        *Object = PVOID(PSERVICESINK(this));
    }
    else
    {
        *Object = NULL;
        return STATUS_NOT_SUPPORTED;
    }

    PUNKNOWN(*Object)->AddRef();
    return STATUS_SUCCESS;
}

NTSTATUS CMiniportWaveCyclicStream::Init(
    _In_ ULONG Pin,
    _In_ BOOLEAN Capture,
    _In_ PCYOMAGDMACHANNEL DmaChannel,
    _In_ CYomagRingBuffer* CableBuffer)
{
    m_Pin = Pin;
    m_Capture = Capture;
    m_DmaChannel = DmaChannel;
    m_DmaChannel->AddRef();
    m_CableBuffer = CableBuffer;
    m_State = KSSTATE_STOP;
    m_Position = 0;
    m_FrameSize = 0;

    return STATUS_SUCCESS;
}

STDMETHODIMP_(NTSTATUS) CMiniportWaveCyclicStream::SetFormat(_In_ PKSDATAFORMAT DataFormat)
{
    if (!IsSupportedFormat(DataFormat))
    {
        return STATUS_INVALID_PARAMETER;
    }
    return STATUS_SUCCESS;
}

STDMETHODIMP_(ULONG) CMiniportWaveCyclicStream::SetNotificationFreq(_In_ ULONG Interval, _Out_ PULONG FrameSize)
{
    // Bytes to move per notification interval (ms).
    m_FrameSize = (ULONG)(((ULONGLONG)YOMAG_AVG_BYTES_PER_SEC * Interval) / 1000);
    // Keep it block-aligned so we never split a sample frame across calls.
    m_FrameSize -= m_FrameSize % YOMAG_BLOCK_ALIGN;
    if (m_FrameSize == 0)
    {
        m_FrameSize = YOMAG_BLOCK_ALIGN;
    }

    *FrameSize = m_FrameSize;
    return Interval;
}

STDMETHODIMP_(NTSTATUS) CMiniportWaveCyclicStream::SetState(_In_ KSSTATE State)
{
    m_State = State;
    if (State == KSSTATE_RUN)
    {
        m_Position = 0;
    }
    return STATUS_SUCCESS;
}

STDMETHODIMP_(NTSTATUS) CMiniportWaveCyclicStream::GetPosition(_Out_ PULONG Position)
{
    *Position = m_Position;
    return STATUS_SUCCESS;
}

STDMETHODIMP_(NTSTATUS) CMiniportWaveCyclicStream::NormalizePhysicalPosition(_Inout_ PLONGLONG PhysicalPosition)
{
    // Byte offset -> 100ns time units.
    *PhysicalPosition = (*PhysicalPosition * 10000000) / YOMAG_AVG_BYTES_PER_SEC;
    return STATUS_SUCCESS;
}

STDMETHODIMP_(void) CMiniportWaveCyclicStream::Silence(
    _Inout_updates_bytes_(ByteCount) PVOID Buffer,
    _In_ ULONG ByteCount)
{
    // 16-bit PCM digital silence is all-zero.
    RtlZeroMemory(Buffer, ByteCount);
}

STDMETHODIMP_(void) CMiniportWaveCyclicStream::RequestService(void)
{
    if (m_State != KSSTATE_RUN || !m_DmaChannel || !m_CableBuffer || m_FrameSize == 0)
    {
        return;
    }

    ULONG dmaBufferSize = m_DmaChannel->BufferSize();
    PUCHAR base = (PUCHAR)m_DmaChannel->SystemAddress();
    if (dmaBufferSize == 0 || !base)
    {
        return;
    }

    ULONG chunk = (m_FrameSize < dmaBufferSize) ? m_FrameSize : dmaBufferSize;
    ULONG spaceToEnd = dmaBufferSize - m_Position;
    ULONG firstPart = (chunk < spaceToEnd) ? chunk : spaceToEnd;
    ULONG secondPart = chunk - firstPart;

    if (m_Capture)
    {
        m_CableBuffer->Read(base + m_Position, firstPart);
        if (secondPart)
        {
            m_CableBuffer->Read(base, secondPart);
        }
    }
    else
    {
        m_CableBuffer->Write(base + m_Position, firstPart);
        if (secondPart)
        {
            m_CableBuffer->Write(base, secondPart);
        }
    }

    m_Position = (m_Position + chunk) % dmaBufferSize;
}
