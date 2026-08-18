#include "common.h"
#include "dmachannel.h"

CYomagDmaChannel::~CYomagDmaChannel()
{
    FreeBuffer();
}

STDMETHODIMP_(NTSTATUS) CYomagDmaChannel::NonDelegatingQueryInterface(REFIID Interface, PVOID* Object)
{
    if (IsEqualGUIDAligned(Interface, IID_IUnknown))
    {
        *Object = PVOID(PUNKNOWN(PDMACHANNEL(this)));
    }
    else if (IsEqualGUIDAligned(Interface, IID_IDmaChannel))
    {
        *Object = PVOID(PDMACHANNEL(this));
    }
    else
    {
        *Object = NULL;
        return STATUS_NOT_SUPPORTED;
    }

    PUNKNOWN(*Object)->AddRef();
    return STATUS_SUCCESS;
}

STDMETHODIMP_(NTSTATUS) CYomagDmaChannel::AllocateBuffer(
    _In_ ULONG BufferSize,
    _In_opt_ PPHYSICAL_ADDRESS PhysicalAddressConstraint)
{
    UNREFERENCED_PARAMETER(PhysicalAddressConstraint);

    FreeBuffer();

    m_Buffer = ExAllocatePool2(POOL_FLAG_NON_PAGED, BufferSize, YOMAG_POOL_TAG);
    if (!m_Buffer)
    {
        return STATUS_INSUFFICIENT_RESOURCES;
    }

    m_AllocatedSize = BufferSize;
    m_ActiveSize = BufferSize;
    return STATUS_SUCCESS;
}

STDMETHODIMP_(void) CYomagDmaChannel::FreeBuffer(void)
{
    if (m_Buffer)
    {
        ExFreePoolWithTag(m_Buffer, YOMAG_POOL_TAG);
        m_Buffer = NULL;
    }
    m_AllocatedSize = 0;
    m_ActiveSize = 0;
}

STDMETHODIMP_(ULONG) CYomagDmaChannel::TransferCount(void)
{
    // No real transfer latency to model for a software-only channel; the
    // buffer is always considered fully available to the caller.
    return m_ActiveSize;
}

STDMETHODIMP_(ULONG) CYomagDmaChannel::MaximumBufferSize(void)
{
    return YOMAG_CABLE_BUFFER_BYTES;
}

STDMETHODIMP_(ULONG) CYomagDmaChannel::AllocatedBufferSize(void)
{
    return m_AllocatedSize;
}

STDMETHODIMP_(ULONG) CYomagDmaChannel::BufferSize(void)
{
    return m_ActiveSize;
}

STDMETHODIMP_(void) CYomagDmaChannel::SetBufferSize(_In_ ULONG BufferSize)
{
    if (BufferSize <= m_AllocatedSize)
    {
        m_ActiveSize = BufferSize;
    }
}

STDMETHODIMP_(PVOID) CYomagDmaChannel::SystemAddress(void)
{
    return m_Buffer;
}

STDMETHODIMP_(PHYSICAL_ADDRESS) CYomagDmaChannel::PhysicalAddress(void)
{
    if (m_Buffer)
    {
        return MmGetPhysicalAddress(m_Buffer);
    }
    PHYSICAL_ADDRESS zero;
    zero.QuadPart = 0;
    return zero;
}

STDMETHODIMP_(PADAPTER_OBJECT) CYomagDmaChannel::GetAdapterObject(void)
{
    // No real bus-master DMA adapter behind a software-only device.
    return NULL;
}

STDMETHODIMP_(void) CYomagDmaChannel::CopyTo(
    _Inout_updates_bytes_(ByteCount) PVOID Destination,
    _In_reads_bytes_(ByteCount) PVOID Source,
    _In_ ULONG ByteCount)
{
    RtlCopyMemory(Destination, Source, ByteCount);
}

STDMETHODIMP_(void) CYomagDmaChannel::CopyFrom(
    _Inout_updates_bytes_(ByteCount) PVOID Destination,
    _In_reads_bytes_(ByteCount) PVOID Source,
    _In_ ULONG ByteCount)
{
    RtlCopyMemory(Destination, Source, ByteCount);
}
