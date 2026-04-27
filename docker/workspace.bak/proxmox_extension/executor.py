import urllib.request
import urllib.parse
import json
import ssl
import argparse
import os

def load_config(filepath):
    config = {}
    if os.path.exists(filepath):
        with open(filepath, 'r') as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    k, v = line.split('=', 1)
                    config[k] = v
    return config

class ProxmoxExecutor:
    def __init__(self, host, token_id, token_secret):
        clean_host = host.replace("https://", "").replace("param", "").replace("http://", "").strip("/")
        # Note: The previous logic was a bit messy with the replace. Let's do it cleanly.
        if "://" in host:
            # Extract host from URL if provided
            parts = host.split("://")
            clean_host = parts[1].split("/")[0]
        else:
            clean_host = host.strip("/")
            
        self.base_url = f"https://{clean_host}/api2/json"
        self.token_id = token_id
        self.token_secret = token_secret
        self.context = ssl._create_unverified_context()

    def _get(self, endpoint, params=None):
        url = f"{self.base_url}{endpoint}"
        if params:
            query_string = urllib.parse.urlencode(params)
            url += f"?{query_string}"

        headers = {
            "Authorization": f"PVEAPIToken={self.token_id}={self.token_secret}",
            "Accept": "application/json"
        }
        
        req = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(req, context=self.context) as response:
                return json.loads(response.read().decode('utf-8'))
        except Exception as e:
            return {"error": str(e)}

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Proxmox API Executor")
    parser.add_argument("--endpoint", required=True, help="API endpoint (e.g., /cluster/resources)")
    parser.add_argument("--vmid", help="VMID to target (optional)")
    
    args = parser.parse_args()

    # Load configuration manually to avoid external dependencies
    config = load_config('proxmox_extension/config.env')

    PVE_HOST = config.get("PVE_HOST")
    PVE_TOKEN_ID = config.get("PVE_TOKEN_ID")
    PVE_TOKEN_SECRET = config.get("PVE_TOKEN_SECRET")

    if not all([PVE_HOST, PVE_TOKEN_ID, PVE_TOKEN_SECRET]):
        print(json.dumps({"error": "Missing Proxmox credentials in config.env"}))
        exit(1)

    executor = ProxmoxExecutor(PVE_HOST, PVE_TOKEN_ID, PVE_TOKEN_SECRET)
    
    params = {}
    if args.vmid:
        params['vmid'] = args.vmid

    result = executor._get(args.endpoint, params)
    print(json.dumps(result, indent=4))
