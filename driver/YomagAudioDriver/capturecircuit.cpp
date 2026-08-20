#include "common.h"
#include "context.h"
#include "streamengine.h"
#include "capturecircuit.h"

enum
{
    YomagCaptureHostPin = 0,
    YomagCaptureBridgePin,
    YomagCapturePinCount
};

static NTSTATUS
EvtYomagCaptureCircuitCreateStream(
    _In_ WDFDEVICE       Device,
    _In_ ACXCIRCUIT      Circuit,
    _In_ ACXPIN          Pin,
    _In_ PACXSTREAM_INIT StreamInit,
    _In_ ACXDATAFORMAT   StreamFormat,
    _In_ const GUID*     SignalProcessingMode,
    _In_ ACXOBJECTBAG    VarArguments
)
{
    PAGED_CODE();
    UNREFERENCED_PARAMETER(Pin);
    UNREFERENCED_PARAMETER(SignalProcessingMode);
    UNREFERENCED_PARAMETER(VarArguments);

    NTSTATUS status;
    PYOMAG_CIRCUIT_CONTEXT circuitCtx = GetYomagCircuitContext(Circuit);

    ACX_STREAM_CALLBACKS streamCallbacks;
    ACX_STREAM_CALLBACKS_INIT(&streamCallbacks);
    streamCallbacks.EvtAcxStreamPrepareHardware = EvtYomagStreamPrepareHardware;
    streamCallbacks.EvtAcxStreamReleaseHardware = EvtYomagStreamReleaseHardware;
    streamCallbacks.EvtAcxStreamRun = EvtYomagStreamRun;
    streamCallbacks.EvtAcxStreamPause = EvtYomagStreamPause;

    status = AcxStreamInitAssignAcxStreamCallbacks(StreamInit, &streamCallbacks);
    if (!NT_SUCCESS(status))
    {
        return status;
    }

    ACX_RT_STREAM_CALLBACKS rtCallbacks;
    ACX_RT_STREAM_CALLBACKS_INIT(&rtCallbacks);
    rtCallbacks.EvtAcxStreamGetHwLatency = EvtYomagStreamGetHwLatency;
    rtCallbacks.EvtAcxStreamAllocateRtPackets = EvtYomagStreamAllocateRtPackets;
    rtCallbacks.EvtAcxStreamFreeRtPackets = EvtYomagStreamFreeRtPackets;
    rtCallbacks.EvtAcxStreamGetCapturePacket = EvtYomagStreamGetCapturePacket;
    rtCallbacks.EvtAcxStreamGetCurrentPacket = EvtYomagStreamGetCurrentPacket;
    rtCallbacks.EvtAcxStreamGetPresentationPosition = EvtYomagStreamGetPresentationPosition;

    status = AcxStreamInitAssignAcxRtStreamCallbacks(StreamInit, &rtCallbacks);
    if (!NT_SUCCESS(status))
    {
        return status;
    }

    AcxStreamInitSetAcxRtStreamSupportsNotifications(StreamInit);

    WDF_OBJECT_ATTRIBUTES attributes;
    WDF_OBJECT_ATTRIBUTES_INIT_CONTEXT_TYPE(&attributes, YOMAG_STREAM_CONTEXT);
    attributes.EvtDestroyCallback = EvtYomagStreamDestroy;

    ACXSTREAM stream;
    status = AcxRtStreamCreate(Device, Circuit, &attributes, &StreamInit, &stream);
    if (!NT_SUCCESS(status))
    {
        return status;
    }

    CYomagCaptureStreamEngine* engine =
        new (POOL_FLAG_NON_PAGED, YOMAG_POOL_TAG) CYomagCaptureStreamEngine(stream, StreamFormat, circuitCtx->CableBuffer);
    if (!engine)
    {
        return STATUS_INSUFFICIENT_RESOURCES;
    }

    PYOMAG_STREAM_CONTEXT streamCtx = GetYomagStreamContext(stream);
    streamCtx->StreamEngine = engine;

    return STATUS_SUCCESS;
}

NTSTATUS
CreateYomagCaptureCircuit(
    _In_  WDFDEVICE          Device,
    _In_  CYomagRingBuffer*  CableBuffer,
    _Out_ ACXCIRCUIT*        Circuit
)
{
    PAGED_CODE();

    NTSTATUS status;
    WDF_OBJECT_ATTRIBUTES attributes;
    ACXCIRCUIT circuit;
    PYOMAG_CIRCUIT_CONTEXT circuitCtx;
    ACXPIN pin[YomagCapturePinCount];

    *Circuit = nullptr;

    ///////////////////////////////////////////////////////////
    // Create the circuit.
    ///////////////////////////////////////////////////////////
    {
        DECLARE_CONST_UNICODE_STRING(circuitName, L"YomagAudio Microphone");

        PACXCIRCUIT_INIT circuitInit = AcxCircuitInitAllocate(Device);
        if (!circuitInit)
        {
            return STATUS_INSUFFICIENT_RESOURCES;
        }

        AcxCircuitInitSetComponentId(circuitInit, &YOMAG_CAPTURE_COMPONENT_GUID);
        (VOID)AcxCircuitInitAssignName(circuitInit, &circuitName);
        AcxCircuitInitSetCircuitType(circuitInit, AcxCircuitTypeCapture);

        status = AcxCircuitInitAssignAcxCreateStreamCallback(circuitInit, EvtYomagCaptureCircuitCreateStream);
        if (!NT_SUCCESS(status))
        {
            AcxCircuitInitFree(circuitInit);
            return status;
        }

        WDF_OBJECT_ATTRIBUTES_INIT_CONTEXT_TYPE(&attributes, YOMAG_CIRCUIT_CONTEXT);
        status = AcxCircuitCreate(Device, &attributes, &circuitInit, &circuit);
        if (!NT_SUCCESS(status))
        {
            AcxCircuitInitFree(circuitInit);
            return status;
        }

        circuitCtx = GetYomagCircuitContext(circuit);
        circuitCtx->CableBuffer = CableBuffer;
    }

    ///////////////////////////////////////////////////////////
    // Create the pins: a host (streaming) pin apps capture from, and a
    // bridge pin carrying the KSNODETYPE_MICROPHONE category so
    // AudioEndpointBuilder recognizes this circuit as a recording
    // endpoint.
    ///////////////////////////////////////////////////////////
    {
        ACX_PIN_CONFIG pinCfg;

        ACX_PIN_CONFIG_INIT(&pinCfg);
        pinCfg.Type = AcxPinTypeSource;
        pinCfg.Communication = AcxPinCommunicationSink;
        pinCfg.Category = &KSCATEGORY_AUDIO;

        WDF_OBJECT_ATTRIBUTES_INIT(&attributes);
        attributes.ParentObject = circuit;
        status = AcxPinCreate(circuit, &attributes, &pinCfg, &pin[YomagCaptureHostPin]);
        if (!NT_SUCCESS(status))
        {
            return status;
        }

        ACX_PIN_CONFIG_INIT(&pinCfg);
        pinCfg.Type = AcxPinTypeSink;
        pinCfg.Communication = AcxPinCommunicationNone;
        pinCfg.Category = &KSNODETYPE_MICROPHONE;

        WDF_OBJECT_ATTRIBUTES_INIT(&attributes);
        attributes.ParentObject = circuit;
        status = AcxPinCreate(circuit, &attributes, &pinCfg, &pin[YomagCaptureBridgePin]);
        if (!NT_SUCCESS(status))
        {
            return status;
        }
    }

    ///////////////////////////////////////////////////////////
    // Register the single fixed format this cable supports.
    ///////////////////////////////////////////////////////////
    {
        ACX_DATAFORMAT_CONFIG formatCfg;
        ACX_DATAFORMAT_CONFIG_INIT_KS(&formatCfg, &YomagWaveFormat);

        WDF_OBJECT_ATTRIBUTES_INIT(&attributes);
        attributes.ParentObject = circuit;

        ACXDATAFORMAT format;
        status = AcxDataFormatCreate(Device, &attributes, &formatCfg, &format);
        if (!NT_SUCCESS(status))
        {
            return status;
        }

        ACXDATAFORMATLIST formatList = AcxPinGetRawDataFormatList(pin[YomagCaptureHostPin]);
        if (!formatList)
        {
            return STATUS_INSUFFICIENT_RESOURCES;
        }

        status = AcxDataFormatListAddDataFormat(formatList, format);
        if (!NT_SUCCESS(status))
        {
            return status;
        }
    }

    status = AcxCircuitAddPins(circuit, pin, YomagCapturePinCount);
    if (!NT_SUCCESS(status))
    {
        return status;
    }

    *Circuit = circuit;
    return STATUS_SUCCESS;
}
