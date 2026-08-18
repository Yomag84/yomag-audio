#pragma once

// A minimal software-only IDmaChannel: just a plain kernel buffer with no
// real bus-master DMA behind it. WaveCyclic needs *some* IDmaChannel to
// hand back from NewStream(), but since this device has no physical
// hardware, PcNewDmaChannel's hardware-oriented DEVICE_DESCRIPTION-based
// allocation isn't a good fit - this is simpler and fully within our
// control. TransferCount() always reports the buffer as fully "transferred"
// since there's no real transfer latency to model; the actual data
// movement happens in CMiniportWaveCyclicStream::Service() via the shared
// CYomagRingBuffer.
class CYomagDmaChannel : public IDmaChannel, public CUnknown
{
public:
    DECLARE_STD_UNKNOWN()
    DEFINE_STD_CONSTRUCTOR(CYomagDmaChannel)
    ~CYomagDmaChannel();

    STDMETHODIMP_(NTSTATUS) AllocateBuffer(
        _In_ ULONG BufferSize,
        _In_opt_ PPHYSICAL_ADDRESS PhysicalAddressConstraint);
    STDMETHODIMP_(void) FreeBuffer(void);
    STDMETHODIMP_(ULONG) TransferCount(void);
    STDMETHODIMP_(ULONG) MaximumBufferSize(void);
    STDMETHODIMP_(ULONG) AllocatedBufferSize(void);
    STDMETHODIMP_(ULONG) BufferSize(void);
    STDMETHODIMP_(void) SetBufferSize(_In_ ULONG BufferSize);
    STDMETHODIMP_(PVOID) SystemAddress(void);
    STDMETHODIMP_(PHYSICAL_ADDRESS) PhysicalAddress(void);
    STDMETHODIMP_(PADAPTER_OBJECT) GetAdapterObject(void);
    STDMETHODIMP_(void) CopyTo(
        _Inout_updates_bytes_(ByteCount) PVOID Destination,
        _In_reads_bytes_(ByteCount) PVOID Source,
        _In_ ULONG ByteCount);
    STDMETHODIMP_(void) CopyFrom(
        _Inout_updates_bytes_(ByteCount) PVOID Destination,
        _In_reads_bytes_(ByteCount) PVOID Source,
        _In_ ULONG ByteCount);

private:
    PVOID  m_Buffer = nullptr;
    ULONG  m_AllocatedSize = 0;
    ULONG  m_ActiveSize = 0;
};

typedef CYomagDmaChannel *PCYOMAGDMACHANNEL;
