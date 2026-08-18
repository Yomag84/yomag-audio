// Every DEFINE_GUID() pulled in below (portcls's own IIDs/CLSIDs, plus ours
// in public.h) is only an `extern` declaration unless INITGUID is defined
// first in exactly one translation unit, which is what actually gives them
// storage for the linker to find.
#define INITGUID
#include <initguid.h>

#include "common.h"
#include "driver.h"
#include "mintopology.h"
#include "minwavecyclic.h"

extern "C" NTSTATUS DriverEntry(_In_ PDRIVER_OBJECT DriverObject, _In_ PUNICODE_STRING RegistryPath)
{
    return PcInitializeAdapterDriver(DriverObject, RegistryPath, (PDRIVER_ADD_DEVICE)AddDevice);
}

NTSTATUS AddDevice(_In_ PDRIVER_OBJECT DriverObject, _In_ PDEVICE_OBJECT PhysicalDeviceObject)
{
    return PcAddAdapterDevice(DriverObject, PhysicalDeviceObject, PCPFNSTARTDEVICE(StartDevice), 2, 0);
}

NTSTATUS StartDevice(_In_ PDEVICE_OBJECT DeviceObject, _In_ PIRP Irp, _In_ PRESOURCELIST ResourceList)
{
    PAGED_CODE();

    NTSTATUS status;
    PUNKNOWN unknownTopology = NULL;
    PUNKNOWN unknownWave = NULL;
    PPORTTOPOLOGY portTopology = NULL;
    PPORTWAVECYCLIC portWave = NULL;

    status = PcNewPort(reinterpret_cast<PPORT*>(&portTopology), CLSID_PortTopology);
    if (!NT_SUCCESS(status))
    {
        goto exit;
    }

    status = CreateMiniportTopology(&unknownTopology, CLSID_YomagMiniportTopology, NULL, NonPagedPoolNx);
    if (!NT_SUCCESS(status))
    {
        goto exit;
    }

    status = portTopology->Init(DeviceObject, Irp, unknownTopology, NULL, ResourceList);
    if (!NT_SUCCESS(status))
    {
        goto exit;
    }

    status = PcRegisterSubdevice(DeviceObject, const_cast<PWSTR>(L"Topology"), PUNKNOWN(portTopology));
    if (!NT_SUCCESS(status))
    {
        goto exit;
    }

    status = PcNewPort(reinterpret_cast<PPORT*>(&portWave), CLSID_PortWaveCyclic);
    if (!NT_SUCCESS(status))
    {
        goto exit;
    }

    status = CreateMiniportWaveCyclic(&unknownWave, CLSID_YomagMiniportWaveCyclic, NULL, NonPagedPoolNx);
    if (!NT_SUCCESS(status))
    {
        goto exit;
    }

    status = portWave->Init(DeviceObject, Irp, unknownWave, NULL, ResourceList);
    if (!NT_SUCCESS(status))
    {
        goto exit;
    }

    status = PcRegisterSubdevice(DeviceObject, const_cast<PWSTR>(L"Wave"), PUNKNOWN(portWave));
    if (!NT_SUCCESS(status))
    {
        goto exit;
    }

    // Cross-filter half of the topology graph AudioEndpointBuilder walks to
    // find each endpoint's host pin - see mintopology.cpp/minwavecyclic.cpp
    // for the full pin layout this connects. FromUnknown/ToUnknown must be
    // each subdevice's IPort (what PcNewPort produced), not the miniport's
    // own IUnknown - passing the miniport here is accepted at compile time
    // (both are PUNKNOWN) but PortCls rejects it at runtime with
    // STATUS_NOT_SUPPORTED, since it needs the port object it already has a
    // relationship with, not the miniport underneath it. "From" must be the
    // OUT-flowing pin and "To" the IN-flowing pin (Microsoft: "a physical
    // connection that carries the analog signal from the OUTPUT pin of its
    // wave-output filter to the INPUT pin of its topology filter"). This is
    // purely topology-graph bookkeeping for PnP/mmdevapi - the actual audio
    // routing is handled independently by the shared ring buffer.
    status = PcRegisterPhysicalConnection(DeviceObject, PUNKNOWN(portWave), 1, PUNKNOWN(portTopology), 0);
    if (!NT_SUCCESS(status))
    {
        goto exit;
    }

    status = PcRegisterPhysicalConnection(DeviceObject, PUNKNOWN(portTopology), 3, PUNKNOWN(portWave), 3);
    if (!NT_SUCCESS(status))
    {
        goto exit;
    }

    status = STATUS_SUCCESS;

exit:
    if (portTopology)
    {
        portTopology->Release();
    }
    if (portWave)
    {
        portWave->Release();
    }
    if (unknownTopology)
    {
        unknownTopology->Release();
    }
    if (unknownWave)
    {
        unknownWave->Release();
    }

    return status;
}
