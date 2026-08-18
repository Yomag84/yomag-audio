#pragma once

// Miniport class IDs, looked up by PcNewMiniport() when PortCls builds this
// adapter's subdevices. Randomly generated; only need to be unique on this
// machine's driver store.
DEFINE_GUID(CLSID_YomagMiniportWaveCyclic,
    0x82b27b7c, 0x1ac7, 0x4926, 0xbe, 0x25, 0x41, 0xcd, 0x22, 0x21, 0xfa, 0x15);
DEFINE_GUID(CLSID_YomagMiniportTopology,
    0x74838d99, 0x41ef, 0x40a3, 0xba, 0x58, 0xca, 0x78, 0x9d, 0xab, 0xe0, 0x8b);

#define YOMAG_POOL_TAG 'audY' // "Yuda" reversed - shows as "Yaud" in pool tag viewers

// The single fixed PCM format this virtual cable supports. Keeping this to
// one format avoids implementing WAVEFORMATEX range negotiation tables.
// Both streaming pins (render/"input" and capture/"output" - see
// MiniportWavePins in minwavecyclic.cpp) share this same data range, so
// raising the channel count here widens the cable in both directions at
// once: a client opening either side must request exactly this many
// channels (IsSupportedFormat), same as it always had to for the format's
// other fields.
#define YOMAG_SAMPLES_PER_SEC   48000
#define YOMAG_CHANNELS          32
#define YOMAG_BITS_PER_SAMPLE   16
#define YOMAG_BLOCK_ALIGN       (YOMAG_CHANNELS * (YOMAG_BITS_PER_SAMPLE / 8))
#define YOMAG_AVG_BYTES_PER_SEC (YOMAG_SAMPLES_PER_SEC * YOMAG_BLOCK_ALIGN)

// Size of the internal cable ring buffer bridging the render pin's DMA
// buffer to the capture pin's DMA buffer: 1 second of audio at the fixed
// format, generous headroom for the two pins' independent service timing.
#define YOMAG_CABLE_BUFFER_BYTES (YOMAG_AVG_BYTES_PER_SEC)
