import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Protocol } from 'pmtiles';
import { layers, namedFlavor } from '@protomaps/basemaps';

const TILES_URL = 'https://tile-proxy.basilveerman.workers.dev/west-north-america.pmtiles';

let protocolRegistered = false;
function ensureProtocol() {
  if (!protocolRegistered) {
    const protocol = new Protocol();
    maplibregl.addProtocol('pmtiles', protocol.tile.bind(protocol));
    protocolRegistered = true;
  }
}

function makePopup(p, onAddChargerRef) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'min-width:130px;padding:2px;';

  const name = document.createElement('div');
  name.style.cssText = 'font-size:13px;font-weight:600;margin-bottom:6px;color:#111;';
  name.textContent = p.name || '';
  wrap.appendChild(name);

  const btn = document.createElement('button');
  btn.textContent = '+ Add as charger';
  btn.style.cssText = 'background:#dcfce7;color:#166534;border:1px solid #86efac;border-radius:4px;padding:3px 9px;font-size:11px;cursor:pointer;width:100%;';
  btn.onclick = () => {
    onAddChargerRef.current?.({ lat: p.geo[0], lon: p.geo[1], label: p.name || `Stop at ${p.geo[0].toFixed(3)},${p.geo[1].toFixed(3)}` });
  };
  wrap.appendChild(btn);
  return wrap;
}

export default function RouteMap({ places, onAddCharger, height = 260 }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const onAddChargerRef = useRef(onAddCharger);
  useEffect(() => { onAddChargerRef.current = onAddCharger; }, [onAddCharger]);

  useEffect(() => {
    const geos = (places || []).filter(p => p.geo);
    if (!containerRef.current || mapRef.current || geos.length === 0) return;

    ensureProtocol();

    const coords = geos.map(p => [p.geo[1], p.geo[0]]);
    const lons = coords.map(c => c[0]);
    const lats = coords.map(c => c[1]);
    const sw = [Math.min(...lons), Math.min(...lats)];
    const ne = [Math.max(...lons), Math.max(...lats)];
    const isSinglePoint = sw[0] === ne[0] && sw[1] === ne[1];

    const baseOpts = {
      container: containerRef.current,
      style: {
        version: 8,
        glyphs: 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf',
        sprite: 'https://protomaps.github.io/basemaps-assets/sprites/v4/light',
        sources: {
          protomaps: {
            type: 'vector',
            url: `pmtiles://${TILES_URL}`,
            attribution: '© <a href="https://openstreetmap.org">OpenStreetMap</a>',
          },
        },
        layers: layers('protomaps', namedFlavor('light'), { lang: 'en' }),
      },
    };

    const map = new maplibregl.Map(
      isSinglePoint
        ? { ...baseOpts, center: sw, zoom: 13 }
        : { ...baseOpts, bounds: [sw, ne], fitBoundsOptions: { padding: 40, maxZoom: 13 } }
    );

    map.on('load', () => {
      if (coords.length >= 2) {
        map.addSource('route', {
          type: 'geojson',
          data: { type: 'Feature', geometry: { type: 'LineString', coordinates: coords } },
        });
        map.addLayer({
          id: 'route-line',
          type: 'line',
          source: 'route',
          paint: { 'line-color': '#1d4ed8', 'line-width': 3, 'line-opacity': 0.85 },
        });
      }

      geos.forEach((p, i) => {
        const el = document.createElement('div');
        const color = i === 0 ? '#16a34a' : i === geos.length - 1 ? '#ea580c' : '#2563eb';
        el.style.cssText = `width:12px;height:12px;border-radius:50%;border:2px solid #fff;background:${color};cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,.4)`;
        new maplibregl.Marker({ element: el })
          .setLngLat([p.geo[1], p.geo[0]])
          .setPopup(new maplibregl.Popup({ offset: 14 }).setDOMContent(makePopup(p, onAddChargerRef)))
          .addTo(map);
      });
    });

    map.on('error', (e) => console.error('MapLibre error:', e));

    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  return (
    <div ref={containerRef} style={{ width: '100%', height: `${height}px`, borderRadius: 7, overflow: 'hidden', marginBottom: 14 }} />
  );
}
