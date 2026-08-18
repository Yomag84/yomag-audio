#pragma once

#include <ntddk.h>

// stdunk.h defines operator new/delete itself (via deprecated
// ExAllocatePoolWithTag) unless this is defined first, per its own
// migration guidance; we provide modern ExAllocatePool2-based versions in
// unknown.cpp instead.
#define _NEW_DELETE_OPERATORS_

#include <portcls.h>
#include <ksmedia.h>
#include <stdunk.h>

#include "public.h"

void* __cdecl operator new(size_t size, POOL_TYPE poolType, ULONG tag);
void* __cdecl operator new(size_t size, POOL_TYPE poolType);
void __cdecl operator delete(void* p, size_t size);
void __cdecl operator delete(void* p);
