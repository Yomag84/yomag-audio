#include "common.h"
#include "streamengine.h"
#include "context.h"

#define YOMAG_HNS_PER_SEC 10000000ULL

// -----------------------------------------------------------------------
// CYomagStreamEngine
// -----------------------------------------------------------------------

CYomagStreamEngine::CYomagStreamEngine(
    _In_ ACXSTREAM Stream,
    _In_ ACXDATAFORMAT StreamFormat,
    _In_ CYomagRingBuffer* CableBuffer
)
    : m_PacketsCount(0)
    , m_PacketSize(0)
    , m_FirstPacketOffset(0)
    , m_NotificationTimer(NULL)
    , m_CurrentState(AcxStreamStateStop)
    , m_CurrentPacket(0)
    , m_Position(0)
    , m_Stream(Stream)
    , m_StreamFormat(StreamFormat)
    , m_StartTime(0)
    , m_StartPosition(0)
    , m_GlitchAdjust(0)
    , m_CableBuffer(CableBuffer)
{
    PAGED_CODE();
    KeQueryPerformanceCounter(&m_PerformanceCounterFrequency);
    RtlZeroMemory(m_Packets, sizeof(m_Packets));
}

CYomagStreamEngine::~CYomagStreamEngine()
{
    PAGED_CODE();
}

// Allocates PacketCount page-aligned, non-paged buffers of PacketSize
// bytes, each wrapped in an MDL so ACX can map it into the client's
// virtual address space. Adapted near-verbatim from Microsoft's ACX
// sample (see streamengine.h's file comment) - this MDL/paging dance is
// exactly the kind of code worth keeping close to a proven reference
// rather than reinventing.
NTSTATUS
CYomagStreamEngine::AllocateRtPackets(
    _In_ ULONG PacketCount,
    _In_ ULONG PacketSize,
    _Out_ PACX_RTPACKET* Packets
)
{
    PAGED_CODE();

    NTSTATUS status = STATUS_SUCCESS;
    PACX_RTPACKET packets = NULL;
    PVOID packetBuffer = NULL;
    ULONG packetAllocSizeInPages = 0;
    ULONG packetAllocSizeInBytes = 0;
    ULONG firstPacketOffset = 0;
    size_t packetsSize = 0;

    if (PacketCount > MAX_PACKET_COUNT)
    {
        status = STATUS_INVALID_PARAMETER;
        goto exit;
    }

    status = RtlSizeTMult(PacketCount, sizeof(ACX_RTPACKET), &packetsSize);
    if (!NT_SUCCESS(status))
    {
        goto exit;
    }

    packets = (PACX_RTPACKET)ExAllocatePool2(POOL_FLAG_NON_PAGED, packetsSize, YOMAG_POOL_TAG);
    if (!packets)
    {
        status = STATUS_NO_MEMORY;
        goto exit;
    }

    // Round up to a page-aligned allocation, then offset packet 0's data
    // within it so packet 0 ends on a page boundary and packet 1 begins on
    // one - keeps every packet's buffer independently page-aligned for the
    // MDL mapping below, without over-allocating for packet 1.
    status = RtlULongAdd(PacketSize, PAGE_SIZE - 1, &packetAllocSizeInPages);
    if (!NT_SUCCESS(status))
    {
        goto exit;
    }
    packetAllocSizeInPages = packetAllocSizeInPages / PAGE_SIZE;
    packetAllocSizeInBytes = PAGE_SIZE * packetAllocSizeInPages;
    firstPacketOffset = packetAllocSizeInBytes - PacketSize;

    for (ULONG i = 0; i < PacketCount; ++i)
    {
        PMDL pMdl = NULL;

        ACX_RTPACKET_INIT(&packets[i]);

        packetBuffer = ExAllocatePool2(POOL_FLAG_NON_PAGED, packetAllocSizeInBytes, YOMAG_POOL_TAG);
        if (packetBuffer == NULL)
        {
            status = STATUS_NO_MEMORY;
            goto exit;
        }

        pMdl = IoAllocateMdl(packetBuffer, packetAllocSizeInBytes, FALSE, TRUE, NULL);
        if (pMdl == NULL)
        {
            status = STATUS_NO_MEMORY;
            goto exit;
        }

        MmBuildMdlForNonPagedPool(pMdl);

        WDF_MEMORY_DESCRIPTOR_INIT_MDL(&(packets[i].RtPacketBuffer), pMdl, packetAllocSizeInBytes);

        packets[i].RtPacketSize = PacketSize;
        packets[i].RtPacketOffset = (i == 0) ? firstPacketOffset : 0;
        m_Packets[i] = packetBuffer;

        packetBuffer = NULL;
    }

    *Packets = packets;
    packets = NULL;
    m_PacketsCount = PacketCount;
    m_PacketSize = PacketSize;
    m_FirstPacketOffset = firstPacketOffset;

exit:
    if (packetBuffer)
    {
        ExFreePoolWithTag(packetBuffer, YOMAG_POOL_TAG);
    }
    if (packets)
    {
        FreeRtPackets(packets, PacketCount);
    }
    return status;
}

VOID
CYomagStreamEngine::FreeRtPackets(
    _Frees_ptr_ PACX_RTPACKET Packets,
    _In_ ULONG PacketCount
)
{
    PAGED_CODE();

    for (ULONG i = 0; i < PacketCount; ++i)
    {
        if (Packets[i].RtPacketBuffer.u.MdlType.Mdl)
        {
            PVOID buffer = MmGetMdlVirtualAddress(Packets[i].RtPacketBuffer.u.MdlType.Mdl);
            IoFreeMdl(Packets[i].RtPacketBuffer.u.MdlType.Mdl);
            ExFreePoolWithTag(buffer, YOMAG_POOL_TAG);
        }
    }
    ExFreePoolWithTag(Packets, YOMAG_POOL_TAG);
}

NTSTATUS
CYomagStreamEngine::PrepareHardware()
{
    PAGED_CODE();

    if (m_CurrentState == AcxStreamStatePause)
    {
        return STATUS_SUCCESS;
    }
    if (m_CurrentState != AcxStreamStateStop)
    {
        return STATUS_INVALID_STATE_TRANSITION;
    }

    WDF_TIMER_CONFIG timerConfig;
    WDF_TIMER_CONFIG_INIT(&timerConfig, CYomagStreamEngine::s_EvtStreamPassCallback);
    timerConfig.AutomaticSerialization = TRUE;
    timerConfig.UseHighResolutionTimer = WdfTrue;
    timerConfig.Period = 0;

    WDF_OBJECT_ATTRIBUTES timerAttributes;
    WDF_OBJECT_ATTRIBUTES_INIT(&timerAttributes);
    WDF_OBJECT_ATTRIBUTES_INIT_CONTEXT_TYPE(&timerAttributes, YOMAG_TIMER_CONTEXT);
    timerAttributes.ParentObject = m_Stream;

    NTSTATUS status = WdfTimerCreate(&timerConfig, &timerAttributes, &m_NotificationTimer);
    if (!NT_SUCCESS(status))
    {
        return status;
    }

    PYOMAG_TIMER_CONTEXT timerCtx = GetYomagTimerContext(m_NotificationTimer);
    timerCtx->StreamEngine = this;

    m_CurrentState = AcxStreamStatePause;
    return STATUS_SUCCESS;
}

NTSTATUS
CYomagStreamEngine::ReleaseHardware()
{
    PAGED_CODE();

    if (m_CurrentState == AcxStreamStateStop)
    {
        return STATUS_SUCCESS;
    }

    if (m_NotificationTimer)
    {
        WdfTimerStop(m_NotificationTimer, TRUE);
        WdfObjectDelete(m_NotificationTimer);
        m_NotificationTimer = NULL;
    }

    KeFlushQueuedDpcs();

    m_Position = 0;
    m_GlitchAdjust = 0;
    m_CurrentPacket = 0;
    m_CurrentState = AcxStreamStateStop;

    return STATUS_SUCCESS;
}

NTSTATUS
CYomagStreamEngine::Run()
{
    PAGED_CODE();

    if (m_CurrentState == AcxStreamStateRun)
    {
        return STATUS_SUCCESS;
    }
    if (m_CurrentState != AcxStreamStatePause)
    {
        return STATUS_INVALID_STATE_TRANSITION;
    }

    // Save the time/position we started running from - if this stream was
    // run and paused before, this lets ScheduleNextPass keep scheduling
    // packet completions correctly while still reporting position from
    // the very start of the stream.
    m_StartTime = (ULONGLONG)KSCONVERT_PERFORMANCE_TIME(m_PerformanceCounterFrequency.QuadPart, KeQueryPerformanceCounter(NULL));
    m_StartPosition = m_Position;
    m_GlitchAdjust = 0;

    ScheduleNextPass();

    m_CurrentState = AcxStreamStateRun;
    return STATUS_SUCCESS;
}

NTSTATUS
CYomagStreamEngine::Pause()
{
    PAGED_CODE();

    if (m_CurrentState == AcxStreamStatePause)
    {
        return STATUS_SUCCESS;
    }
    if (m_CurrentState != AcxStreamStateRun)
    {
        return STATUS_INVALID_STATE_TRANSITION;
    }

    WdfTimerStop(m_NotificationTimer, TRUE);
    m_CurrentState = AcxStreamStatePause;
    return STATUS_SUCCESS;
}

NTSTATUS
CYomagStreamEngine::GetPresentationPosition(
    _Out_ PULONGLONG PositionInBlocks,
    _Out_ PULONGLONG QpcPosition
)
{
    PAGED_CODE();

    ULONG blockAlign = YOMAG_BLOCK_ALIGN;
    LARGE_INTEGER qpc = KeQueryPerformanceCounter(NULL);

    *PositionInBlocks = m_Position / blockAlign;
    *QpcPosition = (ULONGLONG)qpc.QuadPart;
    return STATUS_SUCCESS;
}

NTSTATUS
CYomagStreamEngine::GetCurrentPacket(
    _Out_ PULONG CurrentPacket
)
{
    PAGED_CODE();
    *CurrentPacket = (ULONG)InterlockedCompareExchange((LONG*)&m_CurrentPacket, -1, -1);
    return STATUS_SUCCESS;
}

NTSTATUS
CYomagStreamEngine::GetHwLatency(
    _Out_ ULONG* FifoSize,
    _Out_ ULONG* Delay
)
{
    PAGED_CODE();
    // No real hardware FIFO or DMA latency to report for a software-only
    // device.
    *FifoSize = 0;
    *Delay = 0;
    return STATUS_SUCCESS;
}

VOID
CYomagStreamEngine::s_EvtStreamPassCallback(
    _In_ WDFTIMER Timer
)
{
    PYOMAG_TIMER_CONTEXT timerCtx = GetYomagTimerContext(Timer);
    CYomagStreamEngine* This = (CYomagStreamEngine*)timerCtx->StreamEngine;
    This->StreamPassCallback();
}

VOID
CYomagStreamEngine::StreamPassCallback()
{
    // Move this pass's packet worth of audio between the ring buffer and
    // whichever packet buffer is current.
    ProcessPacket();

    ULONG completedPacket = (ULONG)InterlockedIncrement(&m_CurrentPacket) - 1;
    LARGE_INTEGER qpcCompleted = KeQueryPerformanceCounter(NULL);

    m_LastPacketStart = m_CurrentPacketStart;
    m_CurrentPacketStart = qpcCompleted;

    (void)AcxRtStreamNotifyPacketComplete(m_Stream, completedPacket, (ULONGLONG)qpcCompleted.QuadPart);

    ScheduleNextPass();
}

// Schedules exactly one timer pass, precisely when the *next* packet's
// worth of audio will have elapsed since this stream last resumed from
// Pause - deliberately a one-shot, self-rescheduling timer computed from
// QPC arithmetic rather than a plain periodic timer, so drift never
// accumulates across many packets the way a fixed-period timer's rounding
// error eventually would.
VOID
CYomagStreamEngine::ScheduleNextPass()
{
    ULONG bytesPerSecond = GetBytesPerSecond();

    ULONGLONG nextPacket = (ULONGLONG)m_CurrentPacket + 1;
    ULONGLONG nextPacketStartPosition = nextPacket * m_PacketSize;
    ULONGLONG nextPacketPositionFromLastPause = nextPacketStartPosition - m_StartPosition;
    ULONGLONG nextPacketTimeFromLastPauseHns = nextPacketPositionFromLastPause * YOMAG_HNS_PER_SEC / bytesPerSecond;
    ULONGLONG nextPacketTime = m_StartTime + m_GlitchAdjust + nextPacketTimeFromLastPauseHns;

    ULONGLONG currentTime = (ULONGLONG)KSCONVERT_PERFORMANCE_TIME(m_PerformanceCounterFrequency.QuadPart, KeQueryPerformanceCounter(NULL));

    LONGLONG delay = -(LONGLONG)(nextPacketTime - currentTime);

    if (delay >= 0)
    {
        // We're already late (e.g. broken into by a kernel debugger) -
        // absorb the lost time into the glitch adjustment and run this
        // pass immediately rather than scheduling a timer with a
        // non-negative (i.e. absolute, not relative) delay.
        m_GlitchAdjust += (ULONGLONG)delay;
        StreamPassCallback();
        return;
    }

    WdfTimerStart(m_NotificationTimer, delay);
}

ULONG
CYomagStreamEngine::GetBytesPerSecond()
{
    return AcxDataFormatGetAverageBytesPerSec(m_StreamFormat);
}

// -----------------------------------------------------------------------
// CYomagRenderStreamEngine
// -----------------------------------------------------------------------

CYomagRenderStreamEngine::CYomagRenderStreamEngine(
    _In_ ACXSTREAM Stream,
    _In_ ACXDATAFORMAT StreamFormat,
    _In_ CYomagRingBuffer* CableBuffer
)
    : CYomagStreamEngine(Stream, StreamFormat, CableBuffer)
{
    PAGED_CODE();
}

NTSTATUS
CYomagRenderStreamEngine::SetRenderPacket(
    _In_ ULONG Packet,
    _In_ ULONG Flags,
    _In_ ULONG EosPacketLength
)
{
    PAGED_CODE();
    UNREFERENCED_PARAMETER(Flags);
    UNREFERENCED_PARAMETER(EosPacketLength);

    ULONG currentPacket = (ULONG)InterlockedCompareExchange((LONG*)&m_CurrentPacket, -1, -1);

    // Packets must be handed over in order, one at a time - this is a
    // sanity check only (the actual byte movement happens on this
    // engine's own timer schedule in ProcessPacket, not here).
    if (Packet <= currentPacket)
    {
        return STATUS_DATA_LATE_ERROR;
    }
    if (Packet > currentPacket + 1)
    {
        return STATUS_DATA_OVERRUN;
    }
    return STATUS_SUCCESS;
}

VOID
CYomagRenderStreamEngine::ProcessPacket()
{
    ULONG currentPacket = (ULONG)InterlockedCompareExchange((LONG*)&m_CurrentPacket, -1, -1);
    ULONG packetIndex = currentPacket % m_PacketsCount;
    PUCHAR packetBuffer = (PUCHAR)m_Packets[packetIndex];
    if (packetIndex == 0)
    {
        packetBuffer += m_FirstPacketOffset;
    }

    // The client has already written this packet's audio by now (it was
    // told this packet was available m_PacketsCount passes ago) - push it
    // onto the cable. Write() silently drops any part that doesn't fit
    // rather than blocking, since this runs at DISPATCH_LEVEL on a timer.
    m_CableBuffer->Write(packetBuffer, m_PacketSize);
}

// -----------------------------------------------------------------------
// CYomagCaptureStreamEngine
// -----------------------------------------------------------------------

CYomagCaptureStreamEngine::CYomagCaptureStreamEngine(
    _In_ ACXSTREAM Stream,
    _In_ ACXDATAFORMAT StreamFormat,
    _In_ CYomagRingBuffer* CableBuffer
)
    : CYomagStreamEngine(Stream, StreamFormat, CableBuffer)
{
    PAGED_CODE();
    m_CurrentPacketStart.QuadPart = 0;
    m_LastPacketStart.QuadPart = 0;
}

NTSTATUS
CYomagCaptureStreamEngine::GetCapturePacket(
    _Out_ ULONG* LastCapturePacket,
    _Out_ ULONGLONG* QpcPacketStart,
    _Out_ BOOLEAN* MoreData
)
{
    PAGED_CODE();

    ULONG currentPacket = (ULONG)InterlockedCompareExchange((LONG*)&m_CurrentPacket, -1, -1);
    LONGLONG qpcPacketStart = InterlockedCompareExchange64(&m_LastPacketStart.QuadPart, -1, -1);

    *LastCapturePacket = currentPacket - 1;
    *QpcPacketStart = (ULONGLONG)qpcPacketStart;
    *MoreData = FALSE;
    return STATUS_SUCCESS;
}

VOID
CYomagCaptureStreamEngine::ProcessPacket()
{
    ULONG currentPacket = (ULONG)InterlockedCompareExchange((LONG*)&m_CurrentPacket, -1, -1);
    ULONG packetIndex = currentPacket % m_PacketsCount;
    PUCHAR packetBuffer = (PUCHAR)m_Packets[packetIndex];
    if (packetIndex == 0)
    {
        packetBuffer += m_FirstPacketOffset;
    }

    // Pull this packet's worth of fresh audio off the cable - Read()
    // silence-fills anything the cable didn't have available, so a quiet/
    // absent render source yields digital silence rather than stale data.
    m_CableBuffer->Read(packetBuffer, m_PacketSize);
}

// -----------------------------------------------------------------------
// EVT_ACX_STREAM_*/EVT_ACX_RTSTREAM_* callback wrappers
// -----------------------------------------------------------------------

VOID
EvtYomagStreamDestroy(
    _In_ WDFOBJECT Object
)
{
    PYOMAG_STREAM_CONTEXT ctx = GetYomagStreamContext((ACXSTREAM)Object);
    CYomagStreamEngine* streamEngine = (CYomagStreamEngine*)ctx->StreamEngine;
    ctx->StreamEngine = NULL;
    delete streamEngine;
}

NTSTATUS
EvtYomagStreamGetHwLatency(
    _In_ ACXSTREAM Stream,
    _Out_ ULONG* FifoSize,
    _Out_ ULONG* Delay
)
{
    PAGED_CODE();
    PYOMAG_STREAM_CONTEXT ctx = GetYomagStreamContext(Stream);
    return ((CYomagStreamEngine*)ctx->StreamEngine)->GetHwLatency(FifoSize, Delay);
}

NTSTATUS
EvtYomagStreamAllocateRtPackets(
    _In_ ACXSTREAM Stream,
    _In_ ULONG PacketCount,
    _In_ ULONG PacketSize,
    _Out_ PACX_RTPACKET* Packets
)
{
    PAGED_CODE();
    PYOMAG_STREAM_CONTEXT ctx = GetYomagStreamContext(Stream);
    return ((CYomagStreamEngine*)ctx->StreamEngine)->AllocateRtPackets(PacketCount, PacketSize, Packets);
}

VOID
EvtYomagStreamFreeRtPackets(
    _In_ ACXSTREAM Stream,
    _In_ PACX_RTPACKET Packets,
    _In_ ULONG PacketCount
)
{
    PAGED_CODE();
    PYOMAG_STREAM_CONTEXT ctx = GetYomagStreamContext(Stream);
    ((CYomagStreamEngine*)ctx->StreamEngine)->FreeRtPackets(Packets, PacketCount);
}

NTSTATUS
EvtYomagStreamPrepareHardware(
    _In_ ACXSTREAM Stream
)
{
    PAGED_CODE();
    PYOMAG_STREAM_CONTEXT ctx = GetYomagStreamContext(Stream);
    return ((CYomagStreamEngine*)ctx->StreamEngine)->PrepareHardware();
}

NTSTATUS
EvtYomagStreamReleaseHardware(
    _In_ ACXSTREAM Stream
)
{
    PAGED_CODE();
    PYOMAG_STREAM_CONTEXT ctx = GetYomagStreamContext(Stream);
    return ((CYomagStreamEngine*)ctx->StreamEngine)->ReleaseHardware();
}

NTSTATUS
EvtYomagStreamRun(
    _In_ ACXSTREAM Stream
)
{
    PAGED_CODE();
    PYOMAG_STREAM_CONTEXT ctx = GetYomagStreamContext(Stream);
    return ((CYomagStreamEngine*)ctx->StreamEngine)->Run();
}

NTSTATUS
EvtYomagStreamPause(
    _In_ ACXSTREAM Stream
)
{
    PAGED_CODE();
    PYOMAG_STREAM_CONTEXT ctx = GetYomagStreamContext(Stream);
    return ((CYomagStreamEngine*)ctx->StreamEngine)->Pause();
}

NTSTATUS
EvtYomagStreamGetCurrentPacket(
    _In_ ACXSTREAM Stream,
    _Out_ PULONG CurrentPacket
)
{
    PAGED_CODE();
    PYOMAG_STREAM_CONTEXT ctx = GetYomagStreamContext(Stream);
    return ((CYomagStreamEngine*)ctx->StreamEngine)->GetCurrentPacket(CurrentPacket);
}

NTSTATUS
EvtYomagStreamGetPresentationPosition(
    _In_ ACXSTREAM Stream,
    _Out_ PULONGLONG PositionInBlocks,
    _Out_ PULONGLONG QpcPosition
)
{
    PAGED_CODE();
    PYOMAG_STREAM_CONTEXT ctx = GetYomagStreamContext(Stream);
    return ((CYomagStreamEngine*)ctx->StreamEngine)->GetPresentationPosition(PositionInBlocks, QpcPosition);
}

NTSTATUS
EvtYomagStreamSetRenderPacket(
    _In_ ACXSTREAM Stream,
    _In_ ULONG Packet,
    _In_ ULONG Flags,
    _In_ ULONG EosPacketLength
)
{
    PAGED_CODE();
    PYOMAG_STREAM_CONTEXT ctx = GetYomagStreamContext(Stream);
    return ((CYomagRenderStreamEngine*)ctx->StreamEngine)->SetRenderPacket(Packet, Flags, EosPacketLength);
}

NTSTATUS
EvtYomagStreamGetCapturePacket(
    _In_ ACXSTREAM Stream,
    _Out_ ULONG* LastCapturePacket,
    _Out_ ULONGLONG* QpcPacketStart,
    _Out_ BOOLEAN* MoreData
)
{
    PAGED_CODE();
    PYOMAG_STREAM_CONTEXT ctx = GetYomagStreamContext(Stream);
    return ((CYomagCaptureStreamEngine*)ctx->StreamEngine)->GetCapturePacket(LastCapturePacket, QpcPacketStart, MoreData);
}
