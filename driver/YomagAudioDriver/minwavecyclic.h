#pragma once

#include "ringbuffer.h"
#include "dmachannel.h"

class CMiniportWaveCyclicStream : public IMiniportWaveCyclicStream, public IServiceSink, public CUnknown
{
public:
    DECLARE_STD_UNKNOWN()
    DEFINE_STD_CONSTRUCTOR(CMiniportWaveCyclicStream)
    ~CMiniportWaveCyclicStream();

    NTSTATUS Init(
        _In_ ULONG Pin,
        _In_ BOOLEAN Capture,
        _In_ PCYOMAGDMACHANNEL DmaChannel,
        _In_ CYomagRingBuffer* CableBuffer);

    // IMiniportWaveCyclicStream
    STDMETHODIMP_(NTSTATUS) SetFormat(_In_ PKSDATAFORMAT DataFormat);
    STDMETHODIMP_(ULONG) SetNotificationFreq(_In_ ULONG Interval, _Out_ PULONG FrameSize);
    STDMETHODIMP_(NTSTATUS) SetState(_In_ KSSTATE State);
    STDMETHODIMP_(NTSTATUS) GetPosition(_Out_ PULONG Position);
    STDMETHODIMP_(NTSTATUS) NormalizePhysicalPosition(_Inout_ PLONGLONG PhysicalPosition);
    STDMETHODIMP_(void) Silence(
        _Inout_updates_bytes_(ByteCount) PVOID Buffer,
        _In_ ULONG ByteCount);

    // IServiceSink - PortCls calls this periodically (roughly once per
    // SetNotificationFreq interval) once the stream is running; this is
    // where the actual render<->cable<->capture data movement happens.
    STDMETHODIMP_(void) RequestService(void);

private:
    ULONG               m_Pin = 0;
    BOOLEAN             m_Capture = FALSE;
    KSSTATE             m_State = KSSTATE_STOP;
    ULONG               m_Position = 0;      // byte offset within the DMA buffer
    ULONG               m_FrameSize = 0;     // bytes to move per RequestService()
    PCYOMAGDMACHANNEL   m_DmaChannel = nullptr;
    CYomagRingBuffer*   m_CableBuffer = nullptr;
};

typedef CMiniportWaveCyclicStream *PCMINIPORTWAVECYCLICSTREAM;

class CMiniportWaveCyclic : public IMiniportWaveCyclic, public CUnknown
{
public:
    DECLARE_STD_UNKNOWN()
    DEFINE_STD_CONSTRUCTOR(CMiniportWaveCyclic)
    ~CMiniportWaveCyclic();

    STDMETHODIMP_(NTSTATUS) Init(
        _In_ PUNKNOWN UnknownAdapter,
        _In_ PRESOURCELIST ResourceList,
        _In_ PPORTWAVECYCLIC Port);

    STDMETHODIMP_(NTSTATUS) NewStream(
        _Out_ PMINIPORTWAVECYCLICSTREAM* Stream,
        _In_opt_ PUNKNOWN OuterUnknown,
        _In_ POOL_TYPE PoolType,
        _In_ ULONG Pin,
        _In_ BOOLEAN Capture,
        _In_ PKSDATAFORMAT DataFormat,
        _Out_ PDMACHANNEL* DmaChannel,
        _Out_ PSERVICEGROUP* ServiceGroup);

    STDMETHODIMP_(NTSTATUS) GetDescription(_Out_ PPCFILTER_DESCRIPTOR* Description);

    STDMETHODIMP_(NTSTATUS) DataRangeIntersection(
        _In_ ULONG PinId,
        _In_ PKSDATARANGE DataRange,
        _In_ PKSDATARANGE MatchingDataRange,
        _In_ ULONG OutputBufferLength,
        _Out_writes_bytes_to_opt_(OutputBufferLength, *ResultantFormatLength) PVOID ResultantFormat,
        _Out_ PULONG ResultantFormatLength);

    CYomagRingBuffer m_CableBuffer;

private:
    PPORTWAVECYCLIC m_Port = nullptr;
};

NTSTATUS CreateMiniportWaveCyclic(
    _Out_ PUNKNOWN* Unknown,
    _In_ REFCLSID ClassId,
    _In_opt_ PUNKNOWN UnknownOuter,
    _In_ POOL_TYPE PoolType);
