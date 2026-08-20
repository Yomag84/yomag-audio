#pragma once

#include "ringbuffer.h"

// ACX's RT streaming model is double-buffered packets (MAX_PACKET_COUNT
// below), not a single large cyclic DMA buffer the way classic WaveCyclic
// worked: the client (WASAPI's wave engine) writes/reads directly into
// page-aligned packet buffers this driver allocates and maps into its
// address space, and a self-rescheduling one-shot WDFTIMER - not a
// hardware interrupt, since there's no real hardware - fires once per
// packet duration to hand the *next* packet over. This class hierarchy is
// adapted from Microsoft's own ACX sample (audio/Acx/Samples/Common/
// StreamEngine.* in microsoft/Windows-driver-samples), stripped of
// everything specific to modeling a hardware codec (DRM enforcement,
// wave-file save/replay, tone generation, peak metering): the only thing
// ProcessPacket() below does is move bytes between a packet buffer and the
// shared CYomagRingBuffer (see context.h) - the actual cable.
#define MAX_PACKET_COUNT 2

class CYomagStreamEngine
{
public:
    __drv_maxIRQL(PASSIVE_LEVEL)
    CYomagStreamEngine(
        _In_ ACXSTREAM     Stream,
        _In_ ACXDATAFORMAT StreamFormat,
        _In_ CYomagRingBuffer* CableBuffer
    );

    virtual
    __drv_maxIRQL(PASSIVE_LEVEL)
    ~CYomagStreamEngine();

    virtual
    __drv_maxIRQL(PASSIVE_LEVEL)
    NTSTATUS
    AllocateRtPackets(
        _In_  ULONG           PacketCount,
        _In_  ULONG           PacketSize,
        _Out_ PACX_RTPACKET* Packets
    );

    virtual
    __drv_maxIRQL(PASSIVE_LEVEL)
    VOID
    FreeRtPackets(
        _Frees_ptr_ PACX_RTPACKET Packets,
        _In_        ULONG         PacketCount
    );

    virtual
    __drv_maxIRQL(PASSIVE_LEVEL)
    NTSTATUS
    PrepareHardware();

    virtual
    __drv_maxIRQL(PASSIVE_LEVEL)
    NTSTATUS
    ReleaseHardware();

    virtual
    __drv_maxIRQL(PASSIVE_LEVEL)
    NTSTATUS
    Run();

    virtual
    __drv_maxIRQL(PASSIVE_LEVEL)
    NTSTATUS
    Pause();

    __drv_maxIRQL(PASSIVE_LEVEL)
    NTSTATUS
    GetPresentationPosition(
        _Out_ PULONGLONG PositionInBlocks,
        _Out_ PULONGLONG QpcPosition
    );

    __drv_maxIRQL(PASSIVE_LEVEL)
    NTSTATUS
    GetCurrentPacket(
        _Out_ PULONG CurrentPacket
    );

    __drv_maxIRQL(PASSIVE_LEVEL)
    NTSTATUS
    GetHwLatency(
        _Out_ ULONG* FifoSize,
        _Out_ ULONG* Delay
    );

protected:
    PVOID               m_Packets[MAX_PACKET_COUNT];
    ULONG               m_PacketsCount;
    ULONG               m_PacketSize;
    ULONG               m_FirstPacketOffset;
    WDFTIMER            m_NotificationTimer;
    ACX_STREAM_STATE    m_CurrentState;
    volatile LONG       m_CurrentPacket;
    ULONGLONG           m_Position;
    ACXSTREAM           m_Stream;
    ACXDATAFORMAT       m_StreamFormat;
    ULONGLONG           m_StartTime;
    ULONGLONG           m_StartPosition;
    ULONGLONG           m_GlitchAdjust;
    LARGE_INTEGER       m_PerformanceCounterFrequency;
    LARGE_INTEGER       m_CurrentPacketStart;
    LARGE_INTEGER       m_LastPacketStart;
    CYomagRingBuffer*   m_CableBuffer;

    static
    __drv_maxIRQL(DISPATCH_LEVEL)
    _Function_class_(EVT_WDF_TIMER)
    VOID
    s_EvtStreamPassCallback(
        _In_ WDFTIMER Timer
    );

    virtual
    __drv_maxIRQL(DISPATCH_LEVEL)
    VOID
    StreamPassCallback();

    virtual
    __drv_maxIRQL(DISPATCH_LEVEL)
    VOID
    ScheduleNextPass();

    virtual
    __drv_maxIRQL(DISPATCH_LEVEL)
    ULONG
    GetBytesPerSecond();

    // Moves this pass's packet's worth of audio between the ring buffer
    // and whichever packet buffer m_CurrentPacket currently selects -
    // CYomagRenderStreamEngine writes the cable, CYomagCaptureStreamEngine
    // reads it.
    virtual
    __drv_maxIRQL(DISPATCH_LEVEL)
    VOID
    ProcessPacket() = 0;
};

class CYomagRenderStreamEngine : public CYomagStreamEngine
{
public:
    __drv_maxIRQL(PASSIVE_LEVEL)
    CYomagRenderStreamEngine(
        _In_ ACXSTREAM         Stream,
        _In_ ACXDATAFORMAT     StreamFormat,
        _In_ CYomagRingBuffer* CableBuffer
    );

    // Called (via EvtAcxStreamSetRenderPacket) when the client has
    // finished writing a packet - only a sanity check (packets must be
    // handed over in order), the actual byte movement happens in
    // ProcessPacket() on this engine's own timer schedule, same as the
    // capture side.
    __drv_maxIRQL(PASSIVE_LEVEL)
    NTSTATUS
    SetRenderPacket(
        _In_ ULONG Packet,
        _In_ ULONG Flags,
        _In_ ULONG EosPacketLength
    );

protected:
    virtual
    __drv_maxIRQL(DISPATCH_LEVEL)
    VOID
    ProcessPacket();
};

class CYomagCaptureStreamEngine : public CYomagStreamEngine
{
public:
    __drv_maxIRQL(PASSIVE_LEVEL)
    CYomagCaptureStreamEngine(
        _In_ ACXSTREAM         Stream,
        _In_ ACXDATAFORMAT     StreamFormat,
        _In_ CYomagRingBuffer* CableBuffer
    );

    __drv_maxIRQL(PASSIVE_LEVEL)
    NTSTATUS
    GetCapturePacket(
        _Out_ ULONG*     LastCapturePacket,
        _Out_ ULONGLONG* QpcPacketStart,
        _Out_ BOOLEAN*   MoreData
    );

protected:
    virtual
    __drv_maxIRQL(DISPATCH_LEVEL)
    VOID
    ProcessPacket();
};

// --- EVT_ACX_STREAM_*/EVT_ACX_RTSTREAM_* callbacks -----------------------
// Thin wrappers: recover the CYomagStreamEngine from the ACXSTREAM's
// context (see context.h) and forward. Shared between the render and
// capture circuits except where the RT stream contract itself differs
// (SetRenderPacket vs. GetCapturePacket), matching how the DDIs are
// registered per-direction in rendercircuit.cpp/capturecircuit.cpp.

VOID
EvtYomagStreamDestroy(
    _In_ WDFOBJECT Object
);

NTSTATUS
EvtYomagStreamGetHwLatency(
    _In_  ACXSTREAM Stream,
    _Out_ ULONG* FifoSize,
    _Out_ ULONG* Delay
);

NTSTATUS
EvtYomagStreamAllocateRtPackets(
    _In_  ACXSTREAM       Stream,
    _In_  ULONG           PacketCount,
    _In_  ULONG           PacketSize,
    _Out_ PACX_RTPACKET* Packets
);

VOID
EvtYomagStreamFreeRtPackets(
    _In_ ACXSTREAM       Stream,
    _In_ PACX_RTPACKET   Packets,
    _In_ ULONG           PacketCount
);

NTSTATUS
EvtYomagStreamPrepareHardware(
    _In_ ACXSTREAM Stream
);

NTSTATUS
EvtYomagStreamReleaseHardware(
    _In_ ACXSTREAM Stream
);

NTSTATUS
EvtYomagStreamRun(
    _In_ ACXSTREAM Stream
);

NTSTATUS
EvtYomagStreamPause(
    _In_ ACXSTREAM Stream
);

NTSTATUS
EvtYomagStreamGetCurrentPacket(
    _In_  ACXSTREAM Stream,
    _Out_ PULONG    CurrentPacket
);

NTSTATUS
EvtYomagStreamGetPresentationPosition(
    _In_  ACXSTREAM   Stream,
    _Out_ PULONGLONG  PositionInBlocks,
    _Out_ PULONGLONG  QpcPosition
);

NTSTATUS
EvtYomagStreamSetRenderPacket(
    _In_ ACXSTREAM Stream,
    _In_ ULONG     Packet,
    _In_ ULONG     Flags,
    _In_ ULONG     EosPacketLength
);

NTSTATUS
EvtYomagStreamGetCapturePacket(
    _In_  ACXSTREAM   Stream,
    _Out_ ULONG*      LastCapturePacket,
    _Out_ ULONGLONG*  QpcPacketStart,
    _Out_ BOOLEAN*    MoreData
);
