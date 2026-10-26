// Four Ports configuration. Everything tweakable lives here.
window.N64NP = {
  // Prefix for PeerJS ids on the public PeerJS server, so room codes don't collide with other apps.
  peerPrefix: 'fourports-v1-',

  // null = use PeerJS defaults (Google STUN + PeerJS's free TURN relay).
  // If guests in other homes can't connect, add your own TURN server here, e.g.:
  // iceServers: [
  //   { urls: 'stun:stun.l.google.com:19302' },
  //   { urls: 'turn:YOUR.TURN.HOST:3478', username: 'user', credential: 'pass' }
  // ],
  iceServers: null,

  // EmulatorJS (N64 core = mupen64plus_next, compiled to WebAssembly).
  ejsData: 'https://cdn.emulatorjs.org/stable/data/',

  // Stream settings. The host uploads one stream PER guest, so total upload =
  // videoBitrate x number of guests (players + spectators).
  streamFps: 60,
  videoBitrate: 2000000,

  // Forces WebGL to keep its frame so the canvas can be captured (needed on Safari).
  preserveDrawingBuffer: true,

  // EmulatorJS simulateInput ids (libretro RetroPad) for the N64 core.
  // If a button lands on the wrong N64 button, fix the number here.
  n64: {
    A: 0, B: 1, START: 3,
    DUP: 4, DDOWN: 5, DLEFT: 6, DRIGHT: 7,
    L: 10, R: 11, Z: 12,
    SX_POS: 16, SX_NEG: 17, SY_POS: 18, SY_NEG: 19, // analog stick: right, left, down, up
    CRIGHT: 20, CLEFT: 21, CDOWN: 22, CUP: 23        // C buttons ride the right analog axes
  },
  cButtons: ['CUP', 'CDOWN', 'CLEFT', 'CRIGHT'],

  // Order of the digital button bitmask sent over the network. Host and guests must match.
  digitalOrder: ['A', 'B', 'Z', 'START', 'L', 'R', 'DUP', 'DDOWN', 'DLEFT', 'DRIGHT', 'CUP', 'CDOWN', 'CLEFT', 'CRIGHT'],

  // Guest controller mapping (standard Gamepad API layout: Xbox / PlayStation / MFi).
  // Right stick is always mapped to the C buttons as well.
  gamepadButtons: {
    A: [0],          // bottom face button
    B: [2],          // left face button
    CDOWN: [1],      // right face button
    CLEFT: [3],      // top face button
    Z: [6, 7],       // either trigger
    L: [4], R: [5],
    START: [9],
    DUP: [12], DDOWN: [13], DLEFT: [14], DRIGHT: [15]
  },
  deadzone: 0.15,

  // How often guests resend their full input state, in ms (covers dropped packets).
  inputHeartbeat: 150
};
