// stdunk.h (installed with the WDK headers) declares CUnknown but its
// implementation only ships in the separate WDK *samples* repository, not
// with the headers/libs alone. This is a from-scratch, contract-compatible
// implementation of that same class so the standard STD_CREATE_BODY_ /
// DECLARE_STD_UNKNOWN macros from stdunk.h can be used as-is.
#include "common.h"

void* __cdecl operator new(size_t size, POOL_TYPE poolType, ULONG tag)
{
    UNREFERENCED_PARAMETER(poolType);
    void* p = ExAllocatePool2(POOL_FLAG_NON_PAGED, size, tag);
    if (p)
    {
        RtlZeroMemory(p, size);
    }
    return p;
}

void* __cdecl operator new(size_t size, POOL_TYPE poolType)
{
    return operator new(size, poolType, YOMAG_POOL_TAG);
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

CUnknown::CUnknown(PUNKNOWN pUnknownOuter)
{
    m_lRefCount = 0;
    if (pUnknownOuter)
    {
        m_pUnknownOuter = pUnknownOuter;
    }
    else
    {
        // Standard non-delegating pattern: with no aggregating outer, an
        // object delegates queries to itself.
        m_pUnknownOuter = reinterpret_cast<PUNKNOWN>(reinterpret_cast<PNONDELEGATINGUNKNOWN>(this));
    }
}

CUnknown::~CUnknown(void)
{
}

STDMETHODIMP_(ULONG) CUnknown::NonDelegatingAddRef(void)
{
    return InterlockedIncrement(&m_lRefCount);
}

STDMETHODIMP_(ULONG) CUnknown::NonDelegatingRelease(void)
{
    LONG result = InterlockedDecrement(&m_lRefCount);
    if (result == 0)
    {
        delete this;
    }
    return (ULONG)result;
}

STDMETHODIMP_(NTSTATUS) CUnknown::NonDelegatingQueryInterface(REFIID rIID, PVOID* ppVoid)
{
    if (IsEqualGUIDAligned(rIID, IID_IUnknown))
    {
        *ppVoid = PVOID(PUNKNOWN(PNONDELEGATINGUNKNOWN(this)));
    }
    else
    {
        *ppVoid = NULL;
        return STATUS_NOT_SUPPORTED;
    }

    PUNKNOWN(*ppVoid)->AddRef();
    return STATUS_SUCCESS;
}
