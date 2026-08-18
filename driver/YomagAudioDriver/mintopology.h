#pragma once

// Minimal topology filter: an internal/external pin pair per direction
// (speaker-out, mic-in), connected internally by PCCONNECTION_DESCRIPTOR
// and to the wave filter's own bridge pins by PcRegisterPhysicalConnection
// (see driver.cpp) - see mintopology.cpp for why AudioEndpointBuilder
// needs this shape rather than a single bridge pin per direction.
class CMiniportTopology : public IMiniportTopology, public CUnknown
{
public:
    DECLARE_STD_UNKNOWN()
    DEFINE_STD_CONSTRUCTOR(CMiniportTopology)
    ~CMiniportTopology();

    STDMETHODIMP_(NTSTATUS) Init(
        _In_ PUNKNOWN UnknownAdapter,
        _In_ PRESOURCELIST ResourceList,
        _In_ PPORTTOPOLOGY Port);

    STDMETHODIMP_(NTSTATUS) GetDescription(_Out_ PPCFILTER_DESCRIPTOR* Description);

    STDMETHODIMP_(NTSTATUS) DataRangeIntersection(
        _In_ ULONG PinId,
        _In_ PKSDATARANGE DataRange,
        _In_ PKSDATARANGE MatchingDataRange,
        _In_ ULONG OutputBufferLength,
        _Out_writes_bytes_to_opt_(OutputBufferLength, *ResultantFormatLength) PVOID ResultantFormat,
        _Out_ PULONG ResultantFormatLength);

private:
    PPORTTOPOLOGY m_Port = nullptr;
};

NTSTATUS CreateMiniportTopology(
    _Out_ PUNKNOWN* Unknown,
    _In_ REFCLSID ClassId,
    _In_opt_ PUNKNOWN UnknownOuter,
    _In_ POOL_TYPE PoolType);
