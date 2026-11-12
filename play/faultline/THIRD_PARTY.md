# Third-party code and assets

| What | Where | Licence | Use |
|---|---|---|---|
| Projection Lab engine | `engine/`, `shaders/` | The author's own | Rendering, input, touch controls, audio mixer |
| gl-matrix 3.4.4 | `vendor/gl-matrix@3.4.4` | MIT | Maths, through the engine |
| ZzFX 1.3.2 by Frank Force | `vendor/zzfx@1.3.2` | MIT | Sound effect synthesis |
| Space Grotesk | `vendor/fonts/SpaceGrotesk-latin.woff2` | SIL Open Font License (`vendor/fonts/OFL-SpaceGrotesk.txt`) | UI font, self-hosted |
| JetBrains Mono | `vendor/fonts/JetBrainsMono-latin.woff2` | SIL Open Font License | Copied with the engine, not used by the game |

The 3D models in `assets/models/` are built in Blender by this game's own scripts (`models-src/*/build/`, `tools/models/`). Each is shaped to match reference sheets the author supplied (`models-src/*/ref/`); the rocks, tufts and landmarks also take their colours from those sheets. Terrain, textures, sounds and music are generated in code. Nothing was downloaded for this game. Vehicles, biomes, names and art are original; none of it comes from another game.
