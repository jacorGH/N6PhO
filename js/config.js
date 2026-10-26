// N6PhO configuration. Everything tweakable lives here.
window.N6 = {
  // Prefix for PeerJS ids on the public PeerJS server, so room codes don't collide with other apps.
  peerPrefix: 'n6pho-v1-',

  // null = PeerJS defaults (Google STUN + PeerJS's free TURN relay).
  // If guests in other homes can't connect, add your own TURN server, e.g.:
  // iceServers: [
  //   { urls: 'stun:stun.l.google.com:19302' },
  //   { urls: 'turn:YOUR.TURN.HOST:3478', username: 'user', credential: 'pass' }
  // ],
  iceServers: null,

  // EmulatorJS (N64 core = mupen64plus_next, WebAssembly).
  ejsData: 'https://cdn.emulatorjs.org/stable/data/',

  // Stream. The host uploads one stream PER guest: total upload = videoBitrate x guests.
  streamFps: 60,
  videoBitrate: 2000000,

  // Keeps WebGL frames readable so the canvas can be captured (Safari needs this).
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

  // Order of the button bitmask sent over the network. Host and guests must match.
  digitalOrder: ['A', 'B', 'Z', 'START', 'L', 'R', 'DUP', 'DDOWN', 'DLEFT', 'DRIGHT', 'CUP', 'CDOWN', 'CLEFT', 'CRIGHT'],

  // Guest controller mapping (standard Gamepad API layout). Right stick also = C buttons.
  gamepadButtons: {
    A: [0], B: [2], CDOWN: [1], CLEFT: [3],
    Z: [6, 7], L: [4], R: [5], START: [9],
    DUP: [12], DDOWN: [13], DLEFT: [14], DRIGHT: [15]
  },
  deadzone: 0.15,
  inputHeartbeat: 150,

  // Touch controls
  skin: 'n64',
  hitPad: 3.5,        // extra touch area around each button, in skin units
  stickRange: 0.72,   // fraction of the stick radius needed for full tilt
  defaults: { skin: true, haptics: true, alpha: 0.55 }
};
