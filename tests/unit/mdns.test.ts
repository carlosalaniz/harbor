import { describe, expect, it } from 'vitest';
import { avahiConfWithAllowInterfaces, defaultRouteInterfaces } from '../../src/bootstrap/mdns.js';

// Ubuntu 24.04's shipped file, comments and all (relevant excerpt).
const STOCK = `# This file is part of avahi.
[server]
#host-name=foo
#domain-name=local
#browse-domains=0pointer.de, zeroconf.org
use-ipv4=yes
use-ipv6=yes
#allow-interfaces=eth0
#deny-interfaces=eth1
#check-response-ttl=no
#use-iff-running=no
#enable-dbus=yes
ratelimit-interval-usec=1000000
ratelimit-burst=1000

[wide-area]
enable-wide-area=yes

[publish]
#disable-publishing=no
publish-hinfo=no
publish-workstation=no
`;

describe('default-route interface parsing', () => {
  it('reads the dev of each default route, unique and in order', () => {
    expect(defaultRouteInterfaces('default via 192.168.0.1 dev wlp5s0 proto dhcp src 192.168.0.10 metric 600 \n')).toEqual(['wlp5s0']);
    expect(defaultRouteInterfaces('default via 10.0.0.1 dev eth0 metric 100\ndefault via 192.168.0.1 dev wlp5s0 metric 600\ndefault via 10.0.0.1 dev eth0 metric 100\n')).toEqual(['eth0', 'wlp5s0']);
    expect(defaultRouteInterfaces('')).toEqual([]);
    // Tailscale/Docker are never default routes on a LAN box, but a stray
    // line without `dev` must not blow up.
    expect(defaultRouteInterfaces('default via 192.168.0.1\n')).toEqual([]);
  });
});

describe('avahi allow-interfaces rewrite (decision 107)', () => {
  it('replaces the commented stock line inside [server] and nowhere else', () => {
    const out = avahiConfWithAllowInterfaces(STOCK, ['wlp5s0']);
    expect(out).toContain('\nallow-interfaces=wlp5s0\n');
    expect(out).not.toContain('#allow-interfaces=eth0');
    // everything else untouched, including the other sections
    expect(out).toContain('#deny-interfaces=eth1');
    expect(out).toContain('[publish]\n#disable-publishing=no');
    expect(out.split('allow-interfaces=').length).toBe(2);
  });

  it('is idempotent and updates a stale value', () => {
    const once = avahiConfWithAllowInterfaces(STOCK, ['wlp5s0']);
    expect(avahiConfWithAllowInterfaces(once, ['wlp5s0'])).toBe(once);
    const moved = avahiConfWithAllowInterfaces(once, ['enp3s0']);
    expect(moved).toContain('allow-interfaces=enp3s0');
    expect(moved).not.toContain('allow-interfaces=wlp5s0');
    expect(avahiConfWithAllowInterfaces(STOCK, ['eth0', 'wlan0'])).toContain('allow-interfaces=eth0,wlan0');
  });

  it('inserts the line when [server] has none, and creates the section when the file has none', () => {
    const noLine = STOCK.replace('#allow-interfaces=eth0\n', '');
    const out = avahiConfWithAllowInterfaces(noLine, ['wlp5s0']);
    expect(out.indexOf('[server]\nallow-interfaces=wlp5s0')).toBeGreaterThan(-1);
    const bare = avahiConfWithAllowInterfaces('[publish]\npublish-hinfo=no\n', ['wlp5s0']);
    expect(bare.startsWith('[server]\nallow-interfaces=wlp5s0\n')).toBe(true);
    expect(bare).toContain('[publish]\npublish-hinfo=no');
  });

  it('never writes an empty allow-list (that would silence avahi entirely)', () => {
    expect(avahiConfWithAllowInterfaces(STOCK, [])).toBe(STOCK);
  });

  it('does not touch an allow-interfaces line that lives in another section', () => {
    const odd = STOCK + '\n[reflector]\n#allow-interfaces=lo\n';
    const out = avahiConfWithAllowInterfaces(odd, ['wlp5s0']);
    expect(out).toContain('[reflector]\n#allow-interfaces=lo');
    expect(out).toContain('use-ipv6=yes\nallow-interfaces=wlp5s0\n');
  });
});
