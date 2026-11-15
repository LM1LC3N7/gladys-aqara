# gladys-aqara

External integration for [Gladys Assistant](https://gladysassistant.com): the
**Aqara** hubs (M2, M3…) and their devices through the official **Aqara Open
API** (cloud, a developer project of your own, the account authorized by a
verification code). Unofficial, not affiliated with Aqara. Never tested with a
real device.

- Sensors (temperature, humidity, pressure, light, CO2, PM2.5, VOC, battery,
  power), door/window, leak, presence, smoke and CO detectors.
- Plugs and switches, lights (on/off, brightness); curtain positions read only.
- Turning off is never held by a pause, the daily budget or a read in
  progress; confirmed by the reads that follow.
- Curtain positions, locks, cameras, valves, garage doors, heating and
  cooking stay read only.

User documentation: [English](docs/en.md), [Français](docs/fr.md).

## Development

```bash
npm install
npm test                 # node --test
npm run lint
npm run format:check
npm run mutants          # the guards the tests must defend (slow)
```

See [CLAUDE.md](CLAUDE.md) for the rules of the project and
[TODO.md](TODO.md) for its state. Apache-2.0, see [LICENSE](LICENSE) and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
