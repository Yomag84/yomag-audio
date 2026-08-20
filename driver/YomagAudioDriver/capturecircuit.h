#pragma once

// Builds the capture ("microphone") circuit: a host pin apps/WASAPI open
// to capture from, and a bridge pin carrying KSNODETYPE_MICROPHONE so
// AudioEndpointBuilder recognizes this circuit as a recording endpoint.
NTSTATUS
CreateYomagCaptureCircuit(
    _In_  WDFDEVICE          Device,
    _In_  CYomagRingBuffer*  CableBuffer,
    _Out_ ACXCIRCUIT*        Circuit
);
