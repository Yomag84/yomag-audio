// Plain global operator new/delete for this driver's C++ classes
// (CYomagRingBuffer, the stream engine hierarchy). ACX has no COM/CUnknown
// model the way PortCls did, so unlike the old WDM version of this file,
// there's no stdunk.h contract to satisfy here - just ExAllocatePool2-
// backed overloads, matching the pattern Microsoft's own ACX samples use
// (see audio/Acx/Samples/Common/NewDelete.cpp in
// microsoft/Windows-driver-samples).
#include "common.h"

void* __cdecl operator new(size_t size, POOL_FLAGS poolFlags, ULONG tag)
{
    void* p = ExAllocatePool2(poolFlags, size, tag);
    if (p)
    {
        RtlZeroMemory(p, size);
    }
    return p;
}

void* __cdecl operator new(size_t size, POOL_FLAGS poolFlags)
{
    return operator new(size, poolFlags, YOMAG_POOL_TAG);
}

void __cdecl operator delete(void* p, size_t /*size*/)
{
    if (p)
    {
        ExFreePoolWithTag(p, YOMAG_POOL_TAG);
    }
}

void __cdecl operator delete(void* p)
{
    if (p)
    {
        ExFreePoolWithTag(p, YOMAG_POOL_TAG);
    }
}
