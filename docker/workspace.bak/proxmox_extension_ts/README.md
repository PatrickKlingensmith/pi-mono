# Proxmox Explorer Extension for pi

This extension adds a `proxmox_query` tool to the `pi` coding agent, allowing it to interact directly with a Proxmox VE API.

## Features

- **Endpoint Discovery**: Query key Proxmox endpoints including:
  - `/version`: Get Proxmox version.
  - `/cluster/resources`: List all VMs, containers, etc.
  - `/nodes`: List cluster nodes.
  - `/storage`: List available storage.
  - `/datacenter`: Get datacenter information.
- **Secure-ish**: Uses `rejectUnauthorized: false` to support Proxmox clusters using self-loaded SSL certificates.
- **Easy Integration**: Works seamlessly with `pi`'s tool-calling capabilities.

## Usage

To use the tool, provide the necessary Proxmox credentials.

### Example Prompt

> Use the `proxmox_query` tool to check the status of the cluster at 192.168.50.10 using token `read-only-agent@pve!piAgent` and secret `8aa3b126-fae4-4133-8f7e-0dac0341894c` for the `/cluster/resources` endpoint.

## Installation

You can load this extension directly from its directory:

```bash
pi -e ./proxmox_extension_ts/src/index.ts
```

Or place it in your project's `.pi/extensions/` directory.
