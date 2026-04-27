# ComfyUI Image Generator Extension

Generates images via a remote ComfyUI instance. Uses the standard ComfyUI REST API to submit workflows and retrieve generated images.

## Configuration

Set the following via environment variables or extension config:

- `COMFYUI_HOST` - ComfyUI server IP/hostname (default: `192.168.50.150`)
- `COMFYUI_PORT` - ComfyUI server port (default: `8188`)
- `COMFYUI_SSL` - Use SSL (default: `false`)

## API

### `comfyui.generate(prompt, negative_prompt, options)`

Generates an image and returns a `data:image/png;base64,...` URL.

#### Parameters

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `prompt` | string | yes | - | Positive text prompt |
| `negative_prompt` | string | no | `""` | Negative text prompt |
| `options.width` | number | no | `1024` | Image width |
| `options.height` | number | no | `1024` | Image height |
| `options.steps` | number | no | `20` | Diffusion steps |
| `options.cfg` | number | no | `8.0` | Classifier-free guidance scale |
| `options.sampler` | string | no | `"euler"` | Sampler algorithm |
| `options.scheduler` | string | no | `"normal"` | Scheduler type |
| `options.seed` | number | no | `random` | Random seed (0 = random) |

#### Returns

`Promise<string>` - A `data:image/png;base64,...` PNG image URL.

### `comfyui.checkStatus()`

Checks the current queue and history status.

### `comfyui.listNodes()`

Lists all available node types on the server.

## Example Usage

```ts
import { comfyui } from './extensions/comfyui/comfyui.js';

const imageUrl = await comfyui.generate(
  "a sleek red sports car glistening with water droplets on the paint",
  "blurry, low quality, deformed"
);
```
