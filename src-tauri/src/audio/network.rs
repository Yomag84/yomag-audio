// LAN peer discovery + audio streaming. Deliberately simple, LAN-only
// protocol built on plain UDP - no dependency on external discovery
// libraries (mDNS/Bonjour), just a broadcast beacon every peer sends and
// listens for.
//
// Three fixed ports:
//   - BEACON_PORT: every peer broadcasts "I exist, here's what I publish"
//     every 2s, and listens here for other peers' beacons.
//   - CONTROL_PORT: a peer that wants to receive a published device's audio
//     sends a small "subscribe" datagram here (naming the device and the
//     UDP port it wants audio sent to); the publisher adds that
//     (address, port) to its listener set. The subscriber keeps re-sending
//     this every few seconds as a keepalive - if it stops, the listener
//     entry expires and the stream stops, so there's no separate
//     unsubscribe message to lose.
//   - Audio itself flows on ephemeral ports the subscriber picks, sent
//     directly from the publisher: `[u32 seq][f32 samples...]`, fixed at
//     stereo/48kHz to avoid needing per-stream format negotiation.
//
// Consent model: nothing is ever pulled without a local action. Being seen
// via the beacon is passive/automatic (LAN presence, not audio), but a
// peer's audio only starts flowing once the *receiving* user explicitly
// subscribes, and only devices the *sending* user explicitly published are
// ever offered. There's no encryption or authentication - this is scoped
// to a trusted LAN, not the open internet.
use parking_lot::Mutex;
use ringbuf::traits::{Consumer, Producer, Split};
use ringbuf::{HeapCons, HeapProd, HeapRb};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use super::engine::INTERNAL_SAMPLE_RATE;

const BEACON_PORT: u16 = 47990;
const CONTROL_PORT: u16 = 47991;
pub(crate) const NETWORK_CHANNELS: usize = 2;
const CHUNK_FRAMES: usize = 240;
const PEER_TIMEOUT: Duration = Duration::from_secs(8);
const LISTENER_TIMEOUT: Duration = Duration::from_secs(8);
const BEACON_INTERVAL: Duration = Duration::from_secs(2);
const HELLO_INTERVAL: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PublishedDeviceAnnouncement {
    device_id: String,
    device_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
enum WireMessage {
    #[serde(rename = "beacon")]
    Beacon {
        peer_id: String,
        name: String,
        published: Vec<PublishedDeviceAnnouncement>,
    },
    #[serde(rename = "subscribe")]
    Subscribe {
        peer_id: String,
        device_id: String,
        reply_port: u16,
    },
}

struct PeerRecord {
    name: String,
    addr: IpAddr,
    published: Vec<PublishedDeviceAnnouncement>,
    last_seen: Instant,
}

#[derive(Debug, Clone, Serialize)]
pub struct PeerDeviceInfo {
    pub device_id: String,
    pub device_name: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PeerSnapshot {
    pub peer_id: String,
    pub name: String,
    pub addr: String,
    pub published: Vec<PeerDeviceInfo>,
}

struct PublishedDevice {
    device_name: String,
    listeners: Arc<Mutex<HashMap<SocketAddr, Instant>>>,
    stop_flag: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
}

/// Handle for one subscription to a remote peer's published device; keeps
/// re-sending the keepalive "subscribe" hello and feeds received audio into
/// the ring buffer consumer handed back by `NetworkManager::subscribe`.
/// Dropping this stops the subscription (and, after LISTENER_TIMEOUT, the
/// remote side naturally stops sending once the keepalives stop arriving).
pub struct NetworkSubscription {
    stop_flag: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
}

impl Drop for NetworkSubscription {
    fn drop(&mut self) {
        self.stop_flag.store(true, Ordering::Relaxed);
        if let Some(handle) = self.thread.take() {
            let _ = handle.join();
        }
    }
}

pub struct NetworkManager {
    peer_id: String,
    peers: Arc<Mutex<HashMap<String, PeerRecord>>>,
    published: Arc<Mutex<HashMap<String, PublishedDevice>>>,
    control_send_socket: UdpSocket,
}

impl NetworkManager {
    pub fn new() -> Arc<Self> {
        let peer_id = format!(
            "{:x}-{:x}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos() as u64
        );
        let self_name = std::env::var("COMPUTERNAME").unwrap_or_else(|_| "YomagAudio".to_string());

        let peers: Arc<Mutex<HashMap<String, PeerRecord>>> = Arc::new(Mutex::new(HashMap::new()));
        let published: Arc<Mutex<HashMap<String, PublishedDevice>>> = Arc::new(Mutex::new(HashMap::new()));
        let beacon_stop = Arc::new(AtomicBool::new(false));

        match UdpSocket::bind(("0.0.0.0", 0)) {
            Ok(socket) => match socket.set_broadcast(true) {
                Ok(()) => {
                    let published_for_beacon = published.clone();
                    let peer_id_for_beacon = peer_id.clone();
                    thread::spawn(move || loop {
                        let announcements: Vec<PublishedDeviceAnnouncement> = published_for_beacon
                            .lock()
                            .iter()
                            .map(|(id, d)| PublishedDeviceAnnouncement {
                                device_id: id.clone(),
                                device_name: d.device_name.clone(),
                            })
                            .collect();
                        let msg = WireMessage::Beacon {
                            peer_id: peer_id_for_beacon.clone(),
                            name: self_name.clone(),
                            published: announcements,
                        };
                        if let Ok(json) = serde_json::to_vec(&msg) {
                            let _ = socket.send_to(&json, ("255.255.255.255", BEACON_PORT));
                        }
                        thread::sleep(BEACON_INTERVAL);
                    });
                }
                Err(e) => tracing::warn!(%e, "Failed to enable UDP broadcast for peer beacon"),
            },
            Err(e) => tracing::warn!(%e, "Failed to open UDP beacon send socket"),
        }

        match UdpSocket::bind(("0.0.0.0", BEACON_PORT)) {
            Ok(socket) => {
                let peers_for_recv = peers.clone();
                let self_peer_id = peer_id.clone();
                thread::spawn(move || {
                    let mut buf = [0u8; 4096];
                    loop {
                        match socket.recv_from(&mut buf) {
                            Ok((n, addr)) => {
                                if let Ok(WireMessage::Beacon { peer_id: pid, name, published }) =
                                    serde_json::from_slice::<WireMessage>(&buf[..n])
                                {
                                    if pid == self_peer_id {
                                        continue;
                                    }
                                    peers_for_recv.lock().insert(
                                        pid,
                                        PeerRecord {
                                            name,
                                            addr: addr.ip(),
                                            published,
                                            last_seen: Instant::now(),
                                        },
                                    );
                                }
                            }
                            Err(e) => {
                                tracing::warn!(%e, "Beacon receive error");
                                thread::sleep(Duration::from_millis(500));
                            }
                        }
                    }
                });
            }
            Err(e) => tracing::warn!(%e, "Failed to bind UDP beacon receive socket (port {BEACON_PORT} in use?)"),
        }

        match UdpSocket::bind(("0.0.0.0", CONTROL_PORT)) {
            Ok(socket) => {
                let published_for_control = published.clone();
                thread::spawn(move || {
                    let mut buf = [0u8; 4096];
                    loop {
                        match socket.recv_from(&mut buf) {
                            Ok((n, addr)) => {
                                if let Ok(WireMessage::Subscribe { device_id, reply_port, .. }) =
                                    serde_json::from_slice::<WireMessage>(&buf[..n])
                                {
                                    if let Some(device) = published_for_control.lock().get(&device_id) {
                                        let listener_addr = SocketAddr::new(addr.ip(), reply_port);
                                        device.listeners.lock().insert(listener_addr, Instant::now());
                                    }
                                }
                            }
                            Err(e) => {
                                tracing::warn!(%e, "Control receive error");
                                thread::sleep(Duration::from_millis(500));
                            }
                        }
                    }
                });
            }
            Err(e) => tracing::warn!(%e, "Failed to bind UDP control socket (port {CONTROL_PORT} in use?)"),
        }

        {
            let peers_for_expiry = peers.clone();
            let stop = beacon_stop.clone();
            thread::spawn(move || {
                while !stop.load(Ordering::Relaxed) {
                    thread::sleep(Duration::from_secs(3));
                    peers_for_expiry
                        .lock()
                        .retain(|_, p| p.last_seen.elapsed() < PEER_TIMEOUT);
                }
            });
        }

        let control_send_socket =
            UdpSocket::bind(("0.0.0.0", 0)).expect("failed to bind ephemeral UDP control-send socket");

        Arc::new(Self {
            peer_id,
            peers,
            published,
            control_send_socket,
        })
    }

    pub fn list_peers(&self) -> Vec<PeerSnapshot> {
        self.peers
            .lock()
            .iter()
            .map(|(id, p)| PeerSnapshot {
                peer_id: id.clone(),
                name: p.name.clone(),
                addr: p.addr.to_string(),
                published: p
                    .published
                    .iter()
                    .map(|a| PeerDeviceInfo {
                        device_id: a.device_id.clone(),
                        device_name: a.device_name.clone(),
                    })
                    .collect(),
            })
            .collect()
    }

    /// Starts broadcasting `device_id`'s mix to whoever is currently
    /// subscribed to it. Returns the producer half of the ring buffer the
    /// caller (a VirtualDevice's mixer fan-out) should push mixed audio
    /// into - the same shape as a physical monitor's producer.
    pub fn publish(&self, device_id: String, device_name: String) -> HeapProd<f32> {
        let ring = HeapRb::<f32>::new(INTERNAL_SAMPLE_RATE as usize * NETWORK_CHANNELS * 2);
        let (producer, mut consumer) = ring.split();

        let listeners: Arc<Mutex<HashMap<SocketAddr, Instant>>> = Arc::new(Mutex::new(HashMap::new()));
        let stop_flag = Arc::new(AtomicBool::new(false));
        let listeners_for_thread = listeners.clone();
        let thread_stop = stop_flag.clone();

        let send_socket =
            UdpSocket::bind(("0.0.0.0", 0)).expect("failed to bind ephemeral UDP publish socket");

        let handle = thread::spawn(move || {
            // Feeds off the same mixer fan-out ring buffer a physical
            // monitor does, on the same kind of 5ms sleep-timed loop - same
            // reasoning as mixer_loop's promotion in engine.rs applies here.
            super::mmcss::promote_current_thread_to_pro_audio();

            let mut seq: u32 = 0;
            let mut pull_buf = vec![0.0f32; CHUNK_FRAMES * NETWORK_CHANNELS];
            let mut packet: Vec<u8> = Vec::with_capacity(4 + pull_buf.len() * 4);

            while !thread_stop.load(Ordering::Relaxed) {
                thread::sleep(Duration::from_millis(5));

                let filled = consumer.pop_slice(&mut pull_buf);
                if filled == 0 {
                    continue;
                }

                let active: Vec<SocketAddr> = {
                    let mut guard = listeners_for_thread.lock();
                    guard.retain(|_, last| last.elapsed() < LISTENER_TIMEOUT);
                    guard.keys().copied().collect()
                };
                if active.is_empty() {
                    continue;
                }

                packet.clear();
                packet.extend_from_slice(&seq.to_le_bytes());
                for sample in &pull_buf[..filled] {
                    packet.extend_from_slice(&sample.to_le_bytes());
                }
                seq = seq.wrapping_add(1);

                for addr in &active {
                    let _ = send_socket.send_to(&packet, addr);
                }
            }
        });

        self.published.lock().insert(
            device_id,
            PublishedDevice {
                device_name,
                listeners,
                stop_flag,
                thread: Some(handle),
            },
        );

        producer
    }

    pub fn unpublish(&self, device_id: &str) {
        if let Some(mut device) = self.published.lock().remove(device_id) {
            device.stop_flag.store(true, Ordering::Relaxed);
            if let Some(handle) = device.thread.take() {
                let _ = handle.join();
            }
        }
    }

    /// Subscribes to `device_id` on `peer_id`, sending the initial
    /// "subscribe" request (and repeating it as a keepalive) and decoding
    /// incoming audio into the returned ring buffer consumer.
    pub fn subscribe(
        &self,
        peer_id: &str,
        device_id: &str,
    ) -> Result<(HeapCons<f32>, NetworkSubscription), String> {
        let peer_addr = {
            let peers = self.peers.lock();
            let peer = peers
                .get(peer_id)
                .ok_or_else(|| format!("Unknown peer: {peer_id}"))?;
            peer.addr
        };

        let recv_socket = UdpSocket::bind(("0.0.0.0", 0)).map_err(|e| e.to_string())?;
        recv_socket
            .set_read_timeout(Some(Duration::from_millis(500)))
            .map_err(|e| e.to_string())?;
        let reply_port = recv_socket.local_addr().map_err(|e| e.to_string())?.port();

        let ring = HeapRb::<f32>::new(INTERNAL_SAMPLE_RATE as usize * NETWORK_CHANNELS * 2);
        let (mut producer, consumer) = ring.split();

        let stop_flag = Arc::new(AtomicBool::new(false));
        let thread_stop = stop_flag.clone();
        let control_socket = self.control_send_socket.try_clone().map_err(|e| e.to_string())?;
        let hello = WireMessage::Subscribe {
            peer_id: self.peer_id.clone(),
            device_id: device_id.to_string(),
            reply_port,
        };
        let hello_json = serde_json::to_vec(&hello).map_err(|e| e.to_string())?;
        let control_addr = SocketAddr::new(peer_addr, CONTROL_PORT);

        let handle = thread::spawn(move || {
            // This thread's producer becomes a mixer source on the
            // receiving end - same reasoning as the publish thread above.
            super::mmcss::promote_current_thread_to_pro_audio();

            let mut buf = vec![0u8; 4 + CHUNK_FRAMES * NETWORK_CHANNELS * 4 + 64];
            let mut last_hello = Instant::now()
                .checked_sub(HELLO_INTERVAL + Duration::from_secs(1))
                .unwrap_or_else(Instant::now);

            while !thread_stop.load(Ordering::Relaxed) {
                if last_hello.elapsed() >= HELLO_INTERVAL {
                    let _ = control_socket.send_to(&hello_json, control_addr);
                    last_hello = Instant::now();
                }

                if let Ok((n, _addr)) = recv_socket.recv_from(&mut buf) {
                    if n > 4 {
                        let mut samples = Vec::with_capacity((n - 4) / 4);
                        for chunk in buf[4..n].chunks_exact(4) {
                            samples.push(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
                        }
                        producer.push_slice(&samples);
                    }
                }
            }
        });

        Ok((
            consumer,
            NetworkSubscription {
                stop_flag,
                thread: Some(handle),
            },
        ))
    }
}
