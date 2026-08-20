#pragma once

#include "ringbuffer.h"

// Device context: remembers both circuits (so PrepareHardware/
// ReleaseHardware can add/remove them from the ACX device) and owns the
// shared ring buffer that bridges them - the actual "virtual cable".
typedef struct _YOMAG_DEVICE_CONTEXT
{
    ACXCIRCUIT          RenderCircuit;
    ACXCIRCUIT          CaptureCircuit;
    CYomagRingBuffer*    CableBuffer;
} YOMAG_DEVICE_CONTEXT, *PYOMAG_DEVICE_CONTEXT;

WDF_DECLARE_CONTEXT_TYPE_WITH_NAME(YOMAG_DEVICE_CONTEXT, GetYomagDeviceContext)

// Circuit context: just needs to reach the device's shared ring buffer
// when its EvtAcxCircuitCreateStream callback fires.
typedef struct _YOMAG_CIRCUIT_CONTEXT
{
    CYomagRingBuffer* CableBuffer;
} YOMAG_CIRCUIT_CONTEXT, *PYOMAG_CIRCUIT_CONTEXT;

WDF_DECLARE_CONTEXT_TYPE_WITH_NAME(YOMAG_CIRCUIT_CONTEXT, GetYomagCircuitContext)

// Stream context: holds the C++ stream engine instance (CYomagRenderStream
// or CYomagCaptureStream) backing this ACXSTREAM - every EVT_ACX_STREAM_*
// callback recovers its "this" pointer from here and forwards into it.
typedef struct _YOMAG_STREAM_CONTEXT
{
    PVOID StreamEngine;
} YOMAG_STREAM_CONTEXT, *PYOMAG_STREAM_CONTEXT;

WDF_DECLARE_CONTEXT_TYPE_WITH_NAME(YOMAG_STREAM_CONTEXT, GetYomagStreamContext)

// Timer context: lets the static WDFTIMER callback recover which
// CYomagStreamEngine instance's pass just fired.
typedef struct _YOMAG_TIMER_CONTEXT
{
    PVOID StreamEngine;
} YOMAG_TIMER_CONTEXT, *PYOMAG_TIMER_CONTEXT;

WDF_DECLARE_CONTEXT_TYPE_WITH_NAME(YOMAG_TIMER_CONTEXT, GetYomagTimerContext)
