#pragma once

// Fixed-capacity byte ring buffer bridging the render pin's DMA buffer to
// the capture pin's DMA buffer - this is the actual "virtual cable". Both
// Write() (from the render stream's Service()) and Read() (from the
// capture stream's Service()) run at DISPATCH_LEVEL on independent DPC
// schedules, so all access is spinlock-protected.
class CYomagRingBuffer
{
public:
    CYomagRingBuffer();
    ~CYomagRingBuffer();

    NTSTATUS Initialize(_In_ ULONG CapacityBytes);

    // Returns the number of bytes actually written (may be less than
    // Length if the buffer is full); never blocks.
    ULONG Write(_In_reads_bytes_(Length) const PUCHAR Data, _In_ ULONG Length);

    // Returns the number of bytes actually available before silence-fill;
    // any remaining tail of the caller's buffer is zero-filled so a
    // quiet/absent render source yields silence rather than stale data.
    ULONG Read(_Out_writes_bytes_(Length) PUCHAR Data, _In_ ULONG Length);

private:
    PUCHAR      m_Buffer;
    ULONG       m_Capacity;
    ULONG       m_ReadIndex;
    ULONG       m_WriteIndex;
    ULONG       m_Available;
    KSPIN_LOCK  m_Lock;
};
