# MP3 deck architecture

Updated 2026-10-06. The Tor/Veilid design is proposed, not deployed.

## Current hosted app

The public VPS forwards requests over the home host's existing reverse SSH
tunnel. Extraction, media fetching, and conversion run on the home host.
The HTTP response carries MP3 bytes back along that same path.

```mermaid
flowchart LR
    B["Browser<br/>MP3 deck UI"]
    V["chilos.dev VPS<br/>nginx /tydle/"]
    T["Reverse SSH tunnel<br/>VPS 127.0.0.1:3312 → home 127.0.0.1:3311"]

    subgraph H["Home host: rocksteady"]
        N["Node HTTP server<br/>tydle-deck.service"]
        E["yt-dlp<br/>metadata and audio URL"]
        R["Node media fetcher<br/>validated byte ranges"]
        F["ffmpeg<br/>MP3 conversion and tags"]
        N -->|"video ID"| E
        E -->|"metadata and source URL"| N
        N -->|"source URL and headers"| R
        R -->|"source audio"| F
        F -->|"MP3 stream"| N
    end

    Y["YouTube / Googlevideo"]
    B <-->|"HTTPS: page, API, MP3"| V
    V <--> T
    T <--> N
    E <-->|"HTTPS extraction"| Y
    Y -->|"HTTPS media responses"| R
```

The live configuration selects yt-dlp through `YT_DLP_PATH`; the WASM
`TydleClient` extraction path remains available when that variable is unset.
YouTube sees the home network's public egress IP. The browser buffers the MP3,
offers the file after the response completes successfully, and then shows 100%.
There is currently no Tor routing, Veilid delivery, or shared MP3 cache.

## Proposed Tor + Veilid architecture

This diagram extends the local `veilid-cache-prototype.md` specification:
Tor handles the worker's outbound YouTube requests, while Veilid handles
encrypted delivery and cache reads. The worker, job protocol, Tor integration,
and capability distribution are future work. Veilid traffic is not implicitly
routed through Tor.

```mermaid
flowchart LR
    S["Static HTTPS host<br/>UI and WASM assets"]
    B["Browser<br/>Veilid WASM + Web Crypto"]
    V["Veilid network<br/>independent WSS bootstrap and relay peers"]
    C["Private file capability<br/>route, record keys, decryption key, hashes"]
    D["Veilid DHT cache<br/>encrypted fragment records<br/>1 or 3 independently keyed copies"]
    O["Verified MP3<br/>100% only after integrity checks"]

    subgraph W["Native worker / publisher"]
        J["Job handler<br/>Veilid private route"]
        E["YouTube extractor<br/>and media fetcher"]
        F["ffmpeg<br/>MP3 conversion"]
        P["Chunk, encrypt, publish<br/>AES-GCM and file SHA-256"]
        J --> E
        E -->|"source audio"| F
        F -->|"MP3 bytes"| P
    end

    T["Tor SOCKS proxy<br/>Tor circuits and exit"]
    Y["YouTube / Googlevideo"]

    S -->|"page and assets"| B
    B <-->|"job and live fragment AppCalls"| V
    V <--> J
    E <-->|"proxied HTTPS, including DNS"| T
    T <-->|"HTTPS"| Y
    P -->|"encrypted live fragments via private route"| V
    P -->|"publish fragment records"| D
    P -->|"secure distribution: manual in prototype"| C
    C -->|"import privately"| B
    D -->|"fallback reads through Veilid"| V
    B -->|"decrypt; verify chunk tags, size and hash"| O
```

YouTube would see a Tor exit IP for correctly proxied worker requests. Tor exits
may still be rejected by YouTube; this design does not promise successful
extraction. Keep extraction and media fetching on a compatible Tor exit/session.
There is no automatic fallback to the home IP in this proposed flow.

DHT copies are a cache, not a durability guarantee. Different record keys do
not prove independent storage hosts. If the publisher is offline and every
copy is unavailable, show a cache miss. A later repair or regeneration workflow
would need its own implementation.

## First prototype boundary

The specified first experiment deliberately uses a local MP3 fixture. It proves
live transfer and cold DHT retrieval after stopping the publisher before adding
YouTube, Tor, ffmpeg, discovery, multiple publishers, or automated retention.

```mermaid
flowchart LR
    F["Local MP3 fixture<br/>512 KiB < size ≤ 1 MiB"]
    P["One native publisher<br/>Veilid core"]
    D["DHT<br/>1 or 3 record copies per chunk"]
    C["Private capability JSON<br/>manual file import"]
    B["Fresh browser<br/>Veilid WASM"]
    O["Verified MP3"]
    F --> P
    P -->|"encrypted live fragments"| B
    P -->|"publish; flush; retire local records"| D
    P --> C
    C --> B
    D -->|"cold reads after publisher stops"| B
    B -->|"AES-GCM, length, SHA-256"| O
```

The static page and independent bootstrap/relay peers must remain reachable
during the publisher-shutdown test. Only a verified complete file is saved.
