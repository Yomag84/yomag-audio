#pragma once

// Component IDs, passed to AcxCircuitInitSetComponentId() to uniquely
// identify each circuit instance (vendor-specific, only need to be unique
// on this machine's driver store). Randomly generated.
DEFINE_GUID(YOMAG_RENDER_COMPONENT_GUID,
    0x82b27b7c, 0x1ac7, 0x4926, 0xbe, 0x25, 0x41, 0xcd, 0x22, 0x21, 0xfa, 0x15);
DEFINE_GUID(YOMAG_CAPTURE_COMPONENT_GUID,
    0x74838d99, 0x41ef, 0x40a3, 0xba, 0x58, 0xca, 0x78, 0x9d, 0xab, 0xe0, 0x8b);

#define YOMAG_POOL_TAG 'audY' // "Yuda" reversed - shows as "Yaud" in pool tag viewers

// The single fixed PCM format this virtual cable supports. Keeping this to
// one format avoids implementing WAVEFORMATEX range negotiation tables.
// Both circuits (render/"speaker" and capture/"microphone" - see
// RenderCircuit.cpp/CaptureCircuit.cpp) share this same data format, so
// raising the channel count here widens the cable in both directions at
// once: a client opening either side must request exactly this many
// channels.
#define YOMAG_SAMPLES_PER_SEC   48000
#define YOMAG_CHANNELS          32
#define YOMAG_BITS_PER_SAMPLE   16
#define YOMAG_BLOCK_ALIGN       (YOMAG_CHANNELS * (YOMAG_BITS_PER_SAMPLE / 8))
#define YOMAG_AVG_BYTES_PER_SEC (YOMAG_SAMPLES_PER_SEC * YOMAG_BLOCK_ALIGN)

// Size of the internal cable ring buffer bridging the render circuit's
// stream to the capture circuit's stream: 1 second of audio at the fixed
// format, generous headroom for the two circuits' independent packet
// timing.
#define YOMAG_CABLE_BUFFER_BYTES (YOMAG_AVG_BYTES_PER_SEC)

// KSDATAFORMAT_WAVEFORMATEXTENSIBLE literal for the fixed format above -
// WAVE_FORMAT_EXTENSIBLE (rather than a bare WAVEFORMATEX) is required by
// ACX_DATAFORMAT_CONFIG_INIT_KS for a channel count that doesn't map to a
// standard stereo/5.1/7.1 layout. dwChannelMask is deliberately 0
// (KSAUDIO_SPEAKER_DIRECTOUT): this is a virtual cable carrying N
// independent channels, not a real multichannel speaker layout, so there's
// no positional mapping to declare.
#define NOBITMAP
#include <mmreg.h>

static KSDATAFORMAT_WAVEFORMATEXTENSIBLE YomagWaveFormat =
{
    {
        sizeof(KSDATAFORMAT_WAVEFORMATEXTENSIBLE),
        0, 0, 0,
        STATICGUIDOF(KSDATAFORMAT_TYPE_AUDIO),
        STATICGUIDOF(KSDATAFORMAT_SUBTYPE_PCM),
        STATICGUIDOF(KSDATAFORMAT_SPECIFIER_WAVEFORMATEX)
    },
    {
        {
            WAVE_FORMAT_EXTENSIBLE,
            YOMAG_CHANNELS,
            YOMAG_SAMPLES_PER_SEC,
            YOMAG_AVG_BYTES_PER_SEC,
            YOMAG_BLOCK_ALIGN,
            YOMAG_BITS_PER_SAMPLE,
            sizeof(WAVEFORMATEXTENSIBLE) - sizeof(WAVEFORMATEX)
        },
        YOMAG_BITS_PER_SAMPLE,
        0, // dwChannelMask: KSAUDIO_SPEAKER_DIRECTOUT
        STATICGUIDOF(KSDATAFORMAT_SUBTYPE_PCM)
    }
};
