#include "common.h"
#include "ringbuffer.h"

CYomagRingBuffer::CYomagRingBuffer()
    : m_Buffer(NULL), m_Capacity(0), m_ReadIndex(0), m_WriteIndex(0), m_Available(0)
{
    KeInitializeSpinLock(&m_Lock);
}

CYomagRingBuffer::~CYomagRingBuffer()
{
    if (m_Buffer)
    {
        ExFreePoolWithTag(m_Buffer, YOMAG_POOL_TAG);
        m_Buffer = NULL;
    }
}

NTSTATUS CYomagRingBuffer::Initialize(_In_ ULONG CapacityBytes)
{
    m_Buffer = (PUCHAR)ExAllocatePool2(POOL_FLAG_NON_PAGED, CapacityBytes, YOMAG_POOL_TAG);
    if (!m_Buffer)
    {
        return STATUS_INSUFFICIENT_RESOURCES;
    }
    m_Capacity = CapacityBytes;
    return STATUS_SUCCESS;
}

ULONG CYomagRingBuffer::Write(_In_reads_bytes_(Length) const PUCHAR Data, _In_ ULONG Length)
{
    KIRQL oldIrql;
    KeAcquireSpinLock(&m_Lock, &oldIrql);

    ULONG freeSpace = m_Capacity - m_Available;
    ULONG toWrite = (Length < freeSpace) ? Length : freeSpace;

    for (ULONG i = 0; i < toWrite; i++)
    {
        m_Buffer[m_WriteIndex] = Data[i];
        m_WriteIndex = (m_WriteIndex + 1) % m_Capacity;
    }
    m_Available += toWrite;

    KeReleaseSpinLock(&m_Lock, oldIrql);
    return toWrite;
}

ULONG CYomagRingBuffer::Read(_Out_writes_bytes_(Length) PUCHAR Data, _In_ ULONG Length)
{
    KIRQL oldIrql;
    KeAcquireSpinLock(&m_Lock, &oldIrql);

    ULONG toRead = (Length < m_Available) ? Length : m_Available;

    for (ULONG i = 0; i < toRead; i++)
    {
        Data[i] = m_Buffer[m_ReadIndex];
        m_ReadIndex = (m_ReadIndex + 1) % m_Capacity;
    }
    m_Available -= toRead;

    KeReleaseSpinLock(&m_Lock, oldIrql);

    if (toRead < Length)
    {
        RtlZeroMemory(Data + toRead, Length - toRead);
    }

    return toRead;
}
