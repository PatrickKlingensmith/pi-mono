# Proxmox VE API Reference

This document serves as a quick reference for interacting with the Proxmox VE API.

## 1. Connection Details
* **Base URL Structure**: `https://<PROXMOX_IP_OR_HOSTNAME>:8006/api2/json/`
* **Default Port**: `8006`
* **Protocol**: `HTTPS` (Self-signed certificates are common; use `-k` or `--insecure` with `curl`).

## 2. Authentication
Proxmox uses API Tokens for programmatic access.

### API Token Format
The `Authorization` header must be sent with every request:
`Authorization: P2VEAPIToken=<TOKEN_ID>=<TOKEN_SECRET>`

*   **Example**: `Authorization: PVEAPIToken=read-only-agent@pve!piAgent=8aa3b126-fae4-4133-8f7e-0dac0341894c`

### Other Authentication Methods
* **Ticket-based**: Requires login via `/api2/json/ authentication` to obtain a `ticket` and `CSRFPreventionToken`.

## 3. Common API Endpoints

### Cluster & Node Management
| Endpoint | Description |
| :--- | :--- |
| `/cluster/resources` | **Most Important.** Lists all VMs (qemu), Containers (lxc), and Nodes in the cluster. |
| `/cluster/nodes` | Lists all nodes in the cluster. |
| `/nodes/{node}/status` | Returns detailed status (CPU, RAM, etc.) for a specific node. *Requires `Sys.Audit` permission.* |
| `/nodes/{node}/summary` | Provides a summary of the node's resource usage. |
| `/nodes/{node}/config` | Returns the configuration for the specific node. |

### Virtual Machine (QEMU) & Container (LXC) Management
| Endpoint | Description |
| :--- | :--- |
| `/nodes/{node}/qemu/{vmid}/status` | Gets the status of a specific VM. |
| `/nodes/{node}/qemu/{vmid}/stop` | Stops a VM. |
| `/nodes/{node}/qemu/{vmid}/start` | Starts a VM. |
| `/nodes/{node}/lxc/{vmid}/status` | Gets the status of a specific Container. |
| `/nodes/{node}/lxc/{vmid}/stop` | Stops a Container. |
| `/nodes/{node}/lxc/{vmid}/start` | Starts a Container. |

### Storage & Datacenter
| Endpoint | Description |
| :--- | :--- |
| `/storage` | Lists all configured storage backends. |
| `/datacenter` | Returns datacenter-wide configuration and settings. |

## 4. Request/Response Format
* **Method**: `GET`, `POST`, `PUT`, `DELETE`
* **Content-Type**: `application/json`
* **Response Format**: Always returns a JSON object, typically wrapped in a `data` field:
  ```json
  {
    "data": [ ... ],
    "message": "optional message"
  }
  ```

## 5. Proxmox Shell Interface (`pvesh`)
For command-line automation, the `pvesh` tool provides a way to execute the same API calls via the shell:
`pvesh get /cluster/resources --output json`
