// IP masking utilities for privacy/security

export function maskIP(ip: string | undefined | null): string {
  if (!ip) return '—'
  // Mask last octet of IPv4
  if (ip.includes('.')) {
    const parts = ip.split('.')
    if (parts.length === 4) {
      return `${parts[0]}.${parts[1]}.${parts[2]}.xxx`
    }
  }
  // Mask last hextet of IPv6
  if (ip.includes(':')) {
    const parts = ip.split(':')
    if (parts.length >= 2) {
      return `${parts.slice(0, -1).join(':')}:xxxx`
    }
  }
  // Generic fallback
  return ip.length > 4 ? ip.slice(0, -4) + 'xxxx' : 'xxxx'
}

export function maskPort(port: number | string): string {
  return String(port)
}

export function maskAddress(address: string | undefined | null): string {
  if (!address) return '—'
  // address format: "ip:port" or "alias:port" or "ip"
  const parts = address.split(':')
  if (parts.length >= 2 && !isNaN(Number(parts[parts.length - 1]))) {
    // Has port at the end
    const ipPart = parts.slice(0, -1).join(':')
    const port = parts[parts.length - 1]
    return `${maskIP(ipPart)}:${port}`
  }
  // No port or single IP
  return maskIP(address)
}

export function maskHost(host: string | undefined | null): string {
  if (!host) return '—'
  // Could be IP or hostname
  if (host.includes('.') && !host.includes(':') && /^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return maskIP(host)
  }
  // Likely a hostname - leave as is or mask partially
  return host
}