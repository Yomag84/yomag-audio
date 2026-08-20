// DEFINE_GUID (used in public.h for the component-id GUIDs) only reserves
// storage for the GUIDs in the one translation unit that includes it with
// INITGUID defined - everywhere else it's just an extern declaration.
#define INITGUID
#include "common.h"
#include "driver.h"
#include "context.h"
#include "rendercircuit.h"
#include "capturecircuit.h"

extern "C" NTSTATUS
DriverEntry(
    _In_ PDRIVER_OBJECT DriverObject,
    _In_ PUNICODE_STRING RegistryPath
)
{
    PAGED_CODE();

    NTSTATUS status;
    WDF_DRIVER_CONFIG wdfCfg;
    ACX_DRIVER_CONFIG acxCfg;
    WDFDRIVER driver;
    WDF_OBJECT_ATTRIBUTES attributes;

    WDF_OBJECT_ATTRIBUTES_INIT(&attributes);
    WDF_DRIVER_CONFIG_INIT(&wdfCfg, YomagEvtDeviceAdd);

    status = WdfDriverCreate(DriverObject, RegistryPath, &attributes, &wdfCfg, &driver);
    if (!NT_SUCCESS(status))
    {
        return status;
    }

    ACX_DRIVER_CONFIG_INIT(&acxCfg);
    return AcxDriverInitialize(driver, &acxCfg);
}

NTSTATUS
YomagEvtDeviceAdd(
    _In_    WDFDRIVER       Driver,
    _Inout_ PWDFDEVICE_INIT DeviceInit
)
{
    PAGED_CODE();
    UNREFERENCED_PARAMETER(Driver);

    NTSTATUS status;
    WDF_OBJECT_ATTRIBUTES attributes;
    ACX_DEVICEINIT_CONFIG devInitCfg;
    ACX_DEVICE_CONFIG devCfg;
    WDFDEVICE device;
    PYOMAG_DEVICE_CONTEXT devCtx;
    WDF_PNPPOWER_EVENT_CALLBACKS pnpPowerCallbacks;

    ACX_DEVICEINIT_CONFIG_INIT(&devInitCfg);
    status = AcxDeviceInitInitialize(DeviceInit, &devInitCfg);
    if (!NT_SUCCESS(status))
    {
        return status;
    }

    WDF_PNPPOWER_EVENT_CALLBACKS_INIT(&pnpPowerCallbacks);
    pnpPowerCallbacks.EvtDevicePrepareHardware = YomagEvtDevicePrepareHardware;
    pnpPowerCallbacks.EvtDeviceReleaseHardware = YomagEvtDeviceReleaseHardware;
    WdfDeviceInitSetPnpPowerEventCallbacks(DeviceInit, &pnpPowerCallbacks);

    WDF_OBJECT_ATTRIBUTES_INIT_CONTEXT_TYPE(&attributes, YOMAG_DEVICE_CONTEXT);
    attributes.EvtCleanupCallback = YomagEvtDeviceContextCleanup;

    status = WdfDeviceCreate(&DeviceInit, &attributes, &device);
    if (!NT_SUCCESS(status))
    {
        return status;
    }

    devCtx = GetYomagDeviceContext(device);
    devCtx->RenderCircuit = nullptr;
    devCtx->CaptureCircuit = nullptr;
    devCtx->CableBuffer = nullptr;

    ACX_DEVICE_CONFIG_INIT(&devCfg);
    status = AcxDeviceInitialize(device, &devCfg);
    if (!NT_SUCCESS(status))
    {
        return status;
    }

    // The shared ring buffer bridging the two circuits' streams - the
    // actual "virtual cable". Owned by the device context, freed in
    // YomagEvtDeviceContextCleanup below.
    CYomagRingBuffer* cableBuffer = new (POOL_FLAG_NON_PAGED, YOMAG_POOL_TAG) CYomagRingBuffer();
    if (!cableBuffer)
    {
        return STATUS_INSUFFICIENT_RESOURCES;
    }
    status = cableBuffer->Initialize(YOMAG_CABLE_BUFFER_BYTES);
    if (!NT_SUCCESS(status))
    {
        delete cableBuffer;
        return status;
    }
    devCtx->CableBuffer = cableBuffer;

    // Circuits are created here but only attached to the device (and thus
    // visible to the rest of the system) once PrepareHardware runs, below
    // - the same two-phase pattern Microsoft's own ACX samples use.
    status = CreateYomagRenderCircuit(device, cableBuffer, &devCtx->RenderCircuit);
    if (!NT_SUCCESS(status))
    {
        return status;
    }

    status = CreateYomagCaptureCircuit(device, cableBuffer, &devCtx->CaptureCircuit);
    if (!NT_SUCCESS(status))
    {
        return status;
    }

    WDF_DEVICE_PNP_CAPABILITIES pnpCaps;
    WDF_DEVICE_PNP_CAPABILITIES_INIT(&pnpCaps);
    pnpCaps.SurpriseRemovalOK = WdfTrue;
    WdfDeviceSetPnpCapabilities(device, &pnpCaps);

    return STATUS_SUCCESS;
}

NTSTATUS
YomagEvtDevicePrepareHardware(
    _In_ WDFDEVICE    Device,
    _In_ WDFCMRESLIST ResourceList,
    _In_ WDFCMRESLIST ResourceListTranslated
)
{
    PAGED_CODE();
    UNREFERENCED_PARAMETER(ResourceList);
    UNREFERENCED_PARAMETER(ResourceListTranslated);

    PYOMAG_DEVICE_CONTEXT devCtx = GetYomagDeviceContext(Device);

    NTSTATUS status = AcxDeviceAddCircuit(Device, devCtx->RenderCircuit);
    if (!NT_SUCCESS(status))
    {
        return status;
    }

    return AcxDeviceAddCircuit(Device, devCtx->CaptureCircuit);
}

NTSTATUS
YomagEvtDeviceReleaseHardware(
    _In_ WDFDEVICE    Device,
    _In_ WDFCMRESLIST ResourceListTranslated
)
{
    PAGED_CODE();
    UNREFERENCED_PARAMETER(ResourceListTranslated);

    PYOMAG_DEVICE_CONTEXT devCtx = GetYomagDeviceContext(Device);

    if (devCtx->RenderCircuit)
    {
        (void)AcxDeviceRemoveCircuit(Device, devCtx->RenderCircuit);
    }
    if (devCtx->CaptureCircuit)
    {
        (void)AcxDeviceRemoveCircuit(Device, devCtx->CaptureCircuit);
    }

    return STATUS_SUCCESS;
}

VOID
YomagEvtDeviceContextCleanup(
    _In_ WDFOBJECT WdfDevice
)
{
    PYOMAG_DEVICE_CONTEXT devCtx = GetYomagDeviceContext((WDFDEVICE)WdfDevice);

    if (devCtx->CableBuffer)
    {
        delete devCtx->CableBuffer;
        devCtx->CableBuffer = nullptr;
    }
}
