# Proxmox Extension for pi

This extension allows the `pi` agent to interact with your Proxmox VE cluster using the provided API token.

## 🛠 How it Works

The extension consists of a Python-based `executor.py` that performs HTTPS requests to your Proxmox host. It uses a `config.env` file to securely store your credentials.

## 🚀 How to "Register" this tool

To make this a real capability for me (the agent), you would add the `definition.json` to my `tools` configuration.

Once registered, you won't need to run commands manually. You can simply tell me:
* *"Check the status of all resources in my cluster"*
* *"List the storage available on my Proxm0x host"*
* *"Tell me about the node 'pve-node-01'"*

## ⚙️ Configuration

All credentials are stored in `proxmox_extension/config.env`. 

**⚠️ SECURITY WARNING:** Never share your `config.env` file or commit it to public repositories.

## 🔍 Manual Testing

You can test the tool manually from your terminal using:

```bash
python3 proxmox_extension/executor.py --endpoint /cluster/resources
```
