#pragma once

// Builds the render ("speaker") circuit: a host pin apps/WASAPI open to
// render into, and a bridge pin carrying KSNODETYPE_SPEAKER so
// AudioEndpointBuilder recognizes this circuit as a playback endpoint. See
// context.h for how the circuit reaches the shared cable buffer when a
// stream is actually opened on it.
NTSTATUS
CreateYomagRenderCircuit(
    _In_  WDFDEVICE          Device,
    _In_  CYomagRingBuffer*  CableBuffer,
    _Out_ ACXCIRCUIT*        Circuit
);
