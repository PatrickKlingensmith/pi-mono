import urllib.request
import urllib.parse
import json
import ssl
import urllib3
import sys

# Disable warnings for insecure requests (self-signed certs)
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

class ProxmoxExplorer:
    def __init__(self, host, token_id, token_secret):
        # Ensure host doesn't have http/https prefix to avoid double prefixing
        clean_host = host.replace("https://", "").replace("http://", "").strip("/")
        self.base_url = f"https://{clean_host}/api2/json"
        self.token_id = token_id
        self.token_secret = token_secret
        
        # The token header format for Proxmox: PVEAPIToken=user@realm!tokenid=secret
        self.headers = {
            "Authorization": f"PVEAPIToken={self.token_id}={self.token_secret}",
            "Accept": "application/json"
        }
        # Create an unverified SSL context to allow self-signed certs
        self.context = ssl._create_unverified_context()

    def _get(self, endpoint):
        url = f"{self.base_url}{endpoint}"
        req = urllib.request.Request(url, headers=self.api_headers_for_request())
        try:
            with urllib.request.urlopen(req, context=self.context) as response:
                if response.status == 200:
                    return json.loads(response.read().decode('utf-8'))
                else:
                    return {"error": f"HTTP Status {response.status}"}
        except Exception as e:
            return {"error": str(e)}
            
    def api_headers_for_request(self):
        # Re-constructing to ensure the header is always fresh and correct
        return {
            "Authorization": f"PVEAPIToken={self.token_id}={self.token_secret}",
            "Accept": "application/json"
        }

    def explore(self):
        print(f"[*] Starting Proxmox Exploration at {self.base_url}")
        print(f"[*] Identity: {self.token_id}")
        print("-" * 50)
        
        results = {}

        # 1. Check Version
        print("[+] Checking Proxmox Version...")
        results['version'] = self._get('/version')

        # 2. Check Cluster Resources (The most important part for an Auditor)
        # This endpoint lists all VMs, Containers, etc.
        print("[+] Fetching Cluster Resources (All discovery)...")
        results['resources']                = self._get('/cluster/resources')

        # 3. Check Nodes
        print("[+] Fetching Cluster Nodes...")
        results['nodes'] = self._get('/nodes')

        # 4. Check Storage
        print("[+] Fetching Storage...")
        results['storage'] = self._get('/storage')

        # 5. Check Datacenter status
        print("[+] Fetching Datacenter Info...")
        results['datacenter'] = self._get('/datacenter')

        return results

if __name__ == "__main__":
    # Credentials provided by the user
    PROXMOX_IP = "192.168.50.10"
    TOKEN_ID = "read-only-agent@pve!piAgent"
    TOKEN_SECRET = "8aa3b126-fae4-4133-8f7e-0dac0341894c"

    explorer = ProxmoxExplorer(PROXMOX_IP, TOKEN_ID, TOKEN_SECRET)
    
    try:
        data = explorer.explore()
        print("\n" + "="*50)
        print("EXPLORATION COMPLETE")
        print("="*50 + "\n")
        print(json.dumps(data, indent=4))
    except Exception as e:
        print(f"[!] Fatal error during exploration: {e}")
        sys.exit(1)
