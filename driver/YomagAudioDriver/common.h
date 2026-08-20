#pragma once

#include <ntddk.h>
#include <ntintsafe.h>
#include <windef.h>
#include <mmsystem.h>
#include <wdf.h>
#include <acx.h>
#include <ks.h>
#include <ksmedia.h>

#include "public.h"

// newdelete.cpp - plain global operator new/delete for this driver's C++
// classes (CYomagRingBuffer, the stream engine hierarchy). ACX has no
// COM/CUnknown model the way PortCls did, so there's no stdunk.h contract
// to satisfy here - these are ordinary placement-new overloads matching
// ExAllocatePool2's POOL_FLAGS, the same pattern Microsoft's own ACX
// samples use (see audio/Acx/Samples/Common/NewDelete.cpp in
// microsoft/Windows-driver-samples).
void* __cdecl operator new(size_t size, POOL_FLAGS poolFlags, ULONG tag);
void* __cdecl operator new(size_t size, POOL_FLAGS poolFlags);
void __cdecl operator delete(void* p, size_t size);
void __cdecl operator delete(void* p);
