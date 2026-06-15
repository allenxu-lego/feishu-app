// scripts/feishu_sync.js
import fetch from 'node-fetch';
import { createRequire } from 'module';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 加载 dotenv（仅用于本地开发）
const require = createRequire(import.meta.url);
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

// 配置
const {
  FS_APP_ID,
  FS_APP_SECRET,
  BITABLE_APP_TOKEN,
  PROJECT_TABLE_ID,
  CAPABILITY_TABLE_ID
} = process.env;

const TENANT_TOKEN_URL = 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal/';
const BITABLE_RECORDS_URL = `https://open.feishu.cn/open-apis/bitable/v1/apps/${BITABLE_APP_TOKEN}/tables`;

// ─── Task 1: Feishu Data Fetching ────────────────────────────────────────────

async function getTenantAccessToken() {
  const res = await fetch(TENANT_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: FS_APP_ID, app_secret: FS_APP_SECRET })
  });
  const data = await res.json();
  if (data.code !== 0) {
    throw new Error(`获取 token 失败: ${data.msg}`);
  }
  return data.tenant_access_token;
}

async function fetchWithRetry(url, options, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, options);
      const data = await res.json();
      if (data.code !== 0) {
        throw new Error(`Feishu API error (code ${data.code}): ${data.msg}`);
      }
      return data;
    } catch (err) {
      if (attempt === retries) throw err;
      const delay = Math.pow(2, attempt) * 1000;
      console.warn(`请求失败，${delay / 1000}s 后重试 (${attempt}/${retries}): ${err.message}`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

async function fetchAllRecords(token, tableId, fieldNames) {
  const baseUrl = `${BITABLE_RECORDS_URL}/${tableId}/records`;
  const options = {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`
    }
  };

  const allItems = [];
  let pageToken = undefined;

  do {
    // 构建查询参数
    const params = new URLSearchParams();
    if (pageToken) params.append('page_token', pageToken);
    if (fieldNames && fieldNames.length) {
      params.append('field_names', JSON.stringify(fieldNames));
    }
    params.append('page_size', '100');

    const url = `${baseUrl}?${params.toString()}`;
    const data = await fetchWithRetry(url, options);
    const items = data.data?.items || [];
    allItems.push(...items);
    pageToken = data.data?.has_more ? data.data.page_token : undefined;
  } while (pageToken);

  return allItems;
}

async function fetchProjects(token) {
  console.log('获取 Projects 数据...');
  const items = await fetchAllRecords(token, PROJECT_TABLE_ID, [
    'Project ID',
    'Project Name',
    'Project Type',
    'Lifecycle Status',
    'Health Check',
    'Domain',
    'Capability ID1'
  ]);

  // 安全提取 Capability ID1 的辅助函数
  const safeExtractCapabilityIds = (field) => {
    if (!field) return [];
    if (Array.isArray(field)) {
      return field.flatMap(cb => {
        if (cb && typeof cb === 'object') {
          if (Array.isArray(cb.text_arr)) return cb.text_arr;
          if (cb.text) return [cb.text];
        }
        return [];
      });
    }
    return [];
  };

  const projects = items.map(item => ({
    id: item.record_id,
    projectId: item.fields['Project ID'] || '',
    name: item.fields['Project Name'] || '',
    type: item.fields['Project Type'] || '',
    status: item.fields['Lifecycle Status'] || '',
    health: item.fields['Health Check'] || '',
    domain: item.fields['Domain'] || '',
    capabilityIds: safeExtractCapabilityIds(item.fields['Capability ID1'])
  }));
  console.log(`获取 ${projects.length} 个 Project`);
  return projects;
}

async function fetchCapabilities(token) {
  console.log('获取 Capabilities 数据...');
  const items = await fetchAllRecords(token, CAPABILITY_TABLE_ID, [
    'Capability ID',
    'Digital Owner',
    'Domain',
    'Business Value',
    'Capability'
  ]);

  // 安全提取文本的辅助函数 - 支持字符串和数组两种格式
  const safeExtractText = (field) => {
    if (typeof field === 'string') {
      return field;
    }
    if (Array.isArray(field)) {
      return field.map(item => {
        if (item && typeof item === 'object') {
          return item.text || '';
        }
        return String(item || '');
      }).filter(Boolean).join('\n');
    }
    return String(field || '');
  };

  const capabilities = items.map(item => ({
    id: item.record_id,
    capabilityId: item.fields['Capability ID'] || '',
    capability: safeExtractText(item.fields['Capability']),
    businessValue: safeExtractText(item.fields['Business Value']),
    domain: item.fields['Domain'] || '',
    digitalOwner: safeExtractText(item.fields['Digital Owner'])
  }));
  console.log(`获取 ${capabilities.length} 个 Capability`);
  return capabilities;
}

// ─── Task 2: Relationship Builder ────────────────────────────────────────────

function buildRelationships(projects, capabilities) {
  console.log('构建关系数据...');
  const nodes = [];
  const edges = [];
  const details = {};

  // Track unique entities by ID to avoid duplicates
  const seenNodes = new Set();

  function addNode(id, type, label, shortId) {
    if (seenNodes.has(id)) return;
    seenNodes.add(id);
    nodes.push({ id, type, label, ...(shortId && { shortId }) });
  }

  // Collect all unique domains and digital owners
  const domains = new Set();
  const digitalOwners = new Set();

  projects.forEach(p => { if (p.domain) domains.add(p.domain); });
  capabilities.forEach(c => {
    if (c.domain) domains.add(c.domain);
    if (c.digitalOwner) digitalOwners.add(c.digitalOwner);
  });

  // Add Domain nodes (category)
  domains.forEach(d => {
    addNode(`domain:${d}`, 'category', d);
    details[`domain:${d}`] = { Type: 'Domain', Name: d };
  });

  // Add Digital Owner nodes (person)
  digitalOwners.forEach(owner => {
    addNode(`owner:${owner}`, 'person', owner);
    details[`owner:${owner}`] = { Type: 'Digital Owner', Name: owner };
  });

  // Add Project nodes (item) + Project↔Domain, Project↔Capability edges
  projects.forEach(p => {
    addNode(`project:${p.projectId}`, 'item', p.name, p.projectId);
    details[`project:${p.projectId}`] = {
      Type: 'Project',
      'Project ID': p.projectId,
      Name: p.name,
      'Project Type': p.type,
      Status: p.status,
      Health: p.health,
      Domain: p.domain
    };

    // Project ↔ Domain
    if (p.domain) {
      edges.push({ source: `project:${p.projectId}`, target: `domain:${p.domain}`, type: 'belongs_to_domain' });
    }

    // Project ↔ Capability
    p.capabilityIds.forEach(capId => {
      edges.push({ source: `project:${p.projectId}`, target: `capability:${capId}`, type: 'has_capability' });
    });
  });

  // Add Capability nodes (tag) + Capability↔Domain, Capability↔Digital Owner edges
  capabilities.forEach(c => {
    addNode(`capability:${c.capabilityId}`, 'tag', c.capabilityId, c.capabilityId);
    details[`capability:${c.capabilityId}`] = {
      Type: 'Capability',
      'Capability ID': c.capabilityId,
      Capability: c.capability,
      'Business Value': c.businessValue,
      Domain: c.domain,
      'Digital Owner': c.digitalOwner
    };

    // Capability ↔ Domain
    if (c.domain) {
      edges.push({ source: `capability:${c.capabilityId}`, target: `domain:${c.domain}`, type: 'belongs_to_domain' });
    }

    // Capability ↔ Digital Owner
    if (c.digitalOwner) {
      edges.push({ source: `capability:${c.capabilityId}`, target: `owner:${c.digitalOwner}`, type: 'owned_by' });
    }
  });

  console.log(`${nodes.length} 节点, ${edges.length} 关系`);
  return { nodes, edges, details };
}

// ─── Task 3: Knowledge Graph Config Generator ───────────────────────────────

function generateGraphConfig(relationships) {
  console.log('生成知识图谱配置...');
  const config = {
    config: {
      title: 'Project & Capability Knowledge Graph',
      subtitle: 'Drag nodes to rearrange · Click nodes for details · Scroll to zoom',
      nodeTypes: {
        category: { label: 'Domain', color: '#10b981', radius: 28 },
        person: { label: 'Digital Owner', color: '#f59e0b', radius: 20 },
        item: { label: 'Project', color: '#60a5fa', radius: 22 },
        tag: { label: 'Capability', color: '#a78bfa', radius: 18 }
      },
      edgeTypes: {
        belongs_to_domain: { color: 'rgba(16,185,129,0.25)', width: 1.2 },
        has_capability: { color: 'rgba(167,139,250,0.25)', width: 1.2 },
        owned_by: { color: 'rgba(245,158,11,0.25)', width: 1.2, dash: true }
      },
      filterType: 'category'
    },
    nodes: relationships.nodes,
    edges: relationships.edges,
    details: relationships.details
  };
  console.log('配置生成完成');
  return config;
}

// ─── Task 4: HTML Generator (converted from generate.py) ────────────────────

const TEMPLATE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>__TITLE__</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.8.5/d3.min.js"><\/script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0a0e1a;color:#e0e6f0;overflow:hidden;height:100vh;width:100vw}
.header{position:fixed;top:0;left:0;right:0;z-index:100;background:linear-gradient(180deg,rgba(10,14,26,0.98) 0%,rgba(10,14,26,0.85) 80%,transparent 100%);padding:16px 28px 28px;display:flex;align-items:flex-start;justify-content:space-between}
.header h1{font-size:20px;font-weight:600;background:linear-gradient(135deg,#60a5fa,#a78bfa);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.header .sub{font-size:12px;color:#64748b;margin-top:2px}
.legend{display:flex;gap:16px;align-items:center;flex-wrap:wrap}
.legend-item{display:flex;align-items:center;gap:6px;font-size:12px;color:#94a3b8}
.legend-dot{width:12px;height:12px;border-radius:50%;border:2px solid}
.controls{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:100;display:flex;gap:8px;background:rgba(15,20,35,0.9);border:1px solid rgba(100,116,139,0.2);border-radius:12px;padding:8px 12px;backdrop-filter:blur(12px)}
.controls button{background:rgba(100,116,139,0.15);border:1px solid rgba(100,116,139,0.2);color:#94a3b8;padding:6px 14px;border-radius:8px;cursor:pointer;font-size:12px;transition:all 0.2s}
.controls button:hover{background:rgba(96,165,250,0.2);color:#60a5fa;border-color:rgba(96,165,250,0.3)}
.controls button.active{background:rgba(96,165,250,0.25);color:#60a5fa;border-color:#60a5fa}
.filter-bar{position:fixed;top:70px;left:28px;z-index:100;display:flex;gap:6px;flex-wrap:wrap;max-width:500px}
.filter-chip{padding:4px 12px;border-radius:20px;font-size:11px;cursor:pointer;transition:all 0.2s;border:1px solid}
.detail-panel{position:fixed;top:0;right:-420px;width:400px;height:100vh;background:rgba(12,16,30,0.97);border-left:1px solid rgba(100,116,139,0.2);z-index:200;transition:right 0.35s cubic-bezier(0.4,0,0.2,1);overflow-y:auto;backdrop-filter:blur(20px)}
.detail-panel.open{right:0}
.detail-panel .close-btn{position:absolute;top:16px;right:16px;background:rgba(100,116,139,0.15);border:none;color:#94a3b8;width:32px;height:32px;border-radius:8px;cursor:pointer;font-size:18px;display:flex;align-items:center;justify-content:center}
.detail-panel .close-btn:hover{background:rgba(239,68,68,0.2);color:#f87171}
.detail-header{padding:28px 28px 20px;border-bottom:1px solid rgba(100,116,139,0.15)}
.detail-header .type-badge{display:inline-block;padding:3px 10px;border-radius:12px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:10px}
.detail-header h2{font-size:18px;font-weight:600;color:#f1f5f9;line-height:1.3}
.detail-body{padding:20px 28px 28px}
.detail-row{margin-bottom:16px}
.detail-row .label{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#64748b;margin-bottom:4px}
.detail-row .value{font-size:13px;color:#cbd5e1;line-height:1.5;word-break:break-word}
.detail-row .value.empty{color:#475569;font-style:italic}
.related-section{margin-top:20px;padding-top:20px;border-top:1px solid rgba(100,116,139,0.15)}
.related-section h3{font-size:12px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:12px}
.related-chip{display:inline-block;padding:4px 10px;border-radius:8px;font-size:12px;margin:2px 4px 2px 0;cursor:pointer;transition:all 0.2s;border:1px solid rgba(100,116,139,0.2)}
.related-chip:hover{transform:translateY(-1px)}
svg{width:100%;height:100%}
.tooltip{position:fixed;padding:8px 14px;background:rgba(15,20,40,0.95);border:1px solid rgba(100,116,139,0.3);border-radius:8px;font-size:12px;color:#e0e6f0;pointer-events:none;z-index:300;max-width:280px;backdrop-filter:blur(8px);opacity:0;transition:opacity 0.15s}
</style>
</head>
<body>
<div class="header">
  <div>
    <h1>__TITLE__</h1>
    <div class="sub">__SUBTITLE__</div>
  </div>
  <div class="legend">
    __LEGEND__
  </div>
</div>
<div class="filter-bar" id="filterBar"></div>
<div class="detail-panel" id="detailPanel">
  <button class="close-btn" id="closeBtn">&times;</button>
  <div id="detailContent"></div>
</div>
<div class="controls">
  <button id="btnReset">Reset View</button>
  <button id="btnLabels" class="active">Labels</button>
  __TYPE_BUTTONS__
  <button id="btnAll">Show All</button>
</div>
<div class="tooltip" id="tooltip"></div>
<svg id="graph" style="position:fixed;top:0;left:0;width:100vw;height:100vh"></svg>

<script id="graph-data" type="application/json">
__GRAPH_DATA__
<\/script>

<script>
(function() {
  var DATA = JSON.parse(document.getElementById("graph-data").textContent);
  var COLORS = __COLORS_JS__;
  var EDGE_COLORS = __EDGE_COLORS_JS__;
  var EDGE_WIDTHS = __EDGE_WIDTHS_JS__;
  var EDGE_DASH_SET = __EDGE_DASH_SET__;
  var RADII = __RADIUS_JS__;
  var LABEL_MAX = __LABEL_MAX_JS__;
  var FILTER_TYPE = "__FILTER_TYPE__";
  var FIRST_TYPE = "__FIRST_TYPE__";

  function getRadius(d) { return d.r || RADII[d.type] || 16; }

  var width = window.innerWidth, height = window.innerHeight;
  var showLabels = true, activeFilter = null, wasDragged = false;

  var svg = d3.select("#graph");
  var g = svg.append("g");
  var tooltipEl = document.getElementById("tooltip");
  var panel = document.getElementById("detailPanel");

  var zoomBehavior = d3.zoom().scaleExtent([0.15, 4]).on("zoom", function(ev) {
    g.attr("transform", ev.transform);
  });
  svg.call(zoomBehavior);

  var adjacency = {};
  DATA.nodes.forEach(function(n) { adjacency[n.id] = new Set(); });
  DATA.edges.forEach(function(e) {
    if (adjacency[e.source]) adjacency[e.source].add(e.target);
    if (adjacency[e.target]) adjacency[e.target].add(e.source);
  });

  var simulation = d3.forceSimulation(DATA.nodes)
    .force("link", d3.forceLink(DATA.edges).id(function(d){return d.id}).distance(120).strength(0.4))
    .force("charge", d3.forceManyBody().strength(function(d){
      var r = getRadius(d);
      return r >= 28 ? -600 : r >= 20 ? -400 : -200;
    }))
    .force("center", d3.forceCenter(width/2, height/2))
    .force("collision", d3.forceCollide().radius(function(d){return getRadius(d)+8}))
    .force("x", d3.forceX(width/2).strength(0.03))
    .force("y", d3.forceY(height/2).strength(0.03));

  var link = g.append("g").selectAll("line").data(DATA.edges).enter().append("line")
    .attr("stroke", function(d){return EDGE_COLORS[d.type]||"rgba(100,116,139,0.15)"})
    .attr("stroke-width", function(d){return EDGE_WIDTHS[d.type]||1.2})
    .attr("stroke-dasharray", function(d){return EDGE_DASH_SET.indexOf(d.type)!==-1?"4,4":"none"});

  var node = g.append("g").selectAll("g").data(DATA.nodes).enter().append("g")
    .attr("cursor","pointer")
    .call(d3.drag()
      .on("start", function(ev,d){ if(!ev.active) simulation.alphaTarget(0.3).restart(); d.fx=d.x; d.fy=d.y; wasDragged=false; })
      .on("drag", function(ev,d){ d.fx=ev.x; d.fy=ev.y; wasDragged=true; })
      .on("end", function(ev,d){ if(!ev.active) simulation.alphaTarget(0); d.fx=null; d.fy=null; })
    );

  node.append("circle").attr("r", function(d){return getRadius(d)+6})
    .attr("fill", function(d){return (COLORS[d.type]||COLORS[FIRST_TYPE]).bg}).attr("opacity",0.5).attr("class","glow");
  node.append("circle").attr("r", function(d){return getRadius(d)})
    .attr("fill", function(d){return (COLORS[d.type]||COLORS[FIRST_TYPE]).bg})
    .attr("stroke", function(d){return (COLORS[d.type]||COLORS[FIRST_TYPE]).stroke})
    .attr("stroke-width", function(d){return getRadius(d)>=28?2.5:getRadius(d)>=20?2:1.5})
    .attr("class","main-circle");
  node.append("text")
    .text(function(d){
      var mx = LABEL_MAX[d.type]||18;
      return d.label.length>mx ? d.label.slice(0,mx)+"..." : d.label;
    })
    .attr("text-anchor","middle").attr("dy", function(d){return getRadius(d)+14})
    .attr("font-size", function(d){return getRadius(d)>=28?12:getRadius(d)>=20?11:10})
    .attr("fill", function(d){return (COLORS[d.type]||COLORS[FIRST_TYPE]).fill})
    .attr("font-weight", function(d){return getRadius(d)>=20?600:400})
    .attr("opacity",0.85).attr("class","node-label").attr("pointer-events","none");
  node.filter(function(d){return !!d.shortId}).append("text")
    .text(function(d){return d.shortId})
    .attr("text-anchor","middle").attr("dy",4)
    .attr("font-size",8).attr("fill", function(d){return (COLORS[d.type]||COLORS[FIRST_TYPE]).fill})
    .attr("font-weight",700).attr("opacity",0.9).attr("pointer-events","none");

  function highlightConnected(d) {
    var connected = adjacency[d.id] || new Set();
    node.select(".main-circle").attr("opacity", function(n){return n.id===d.id||connected.has(n.id)?1:0.15});
    node.select(".glow").attr("opacity", function(n){return n.id===d.id||connected.has(n.id)?0.6:0.05});
    node.selectAll(".node-label").attr("opacity", function(n){return n.id===d.id||connected.has(n.id)?1:0.1});
    link.attr("opacity", function(l){
      var s=typeof l.source==="object"?l.source.id:l.source;
      var t=typeof l.target==="object"?l.target.id:l.target;
      return s===d.id||t===d.id?1:0.05;
    }).attr("stroke-width", function(l){
      var s=typeof l.source==="object"?l.source.id:l.source;
      var t=typeof l.target==="object"?l.target.id:l.target;
      return s===d.id||t===d.id?3:(EDGE_WIDTHS[l.type]||1.2);
    });
  }

  function clearHighlight() {
    activeFilter = null;
    node.select(".main-circle").attr("opacity",1);
    node.select(".glow").attr("opacity",0.5);
    node.selectAll(".node-label").attr("opacity", showLabels?0.85:0);
    link.attr("opacity",1).attr("stroke-width", function(d){return EDGE_WIDTHS[d.type]||1.2});
  }

  function highlightType(type) {
    activeFilter = type;
    node.select(".main-circle").attr("opacity", function(d){return d.type===type?1:0.1});
    node.select(".glow").attr("opacity", function(d){return d.type===type?0.6:0.03});
    node.selectAll(".node-label").attr("opacity", function(d){return d.type===type?1:0.08});
    link.attr("opacity",0.05).attr("stroke-width",1);
  }

  function escapeHtml(s) {
    if (!s) return "";
    return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
  }

  function showDetail(d) {
    var det = DATA.details[d.id] || {};
    var c = COLORS[d.type] || COLORS[FIRST_TYPE];
    var html = "<div class=\\"detail-header\\">";
    html += "<div class=\\"type-badge\\" style=\\"background:"+c.bg+";color:"+c.fill+"\\">"+escapeHtml(det.Type||d.type)+"</div>";
    html += "<h2>"+escapeHtml(d.label)+"</h2></div>";
    html += "<div class=\\"detail-body\\">";
    var keys = Object.keys(det);
    for (var i=0; i<keys.length; i++) {
      var k = keys[i];
      if (k === "Type") continue;
      var v = det[k];
      var isEmpty = !v || v==="nan" || v==="" || v==="None";
      html += "<div class=\\"detail-row\\"><div class=\\"label\\">"+escapeHtml(k)+"</div>";
      html += "<div class=\\"value"+(isEmpty?" empty":"")+"\\">"+(isEmpty?"N/A":escapeHtml(v))+"</div></div>";
    }
    var related = [];
    DATA.edges.forEach(function(e){
      var s=typeof e.source==="object"?e.source.id:e.source;
      var t=typeof e.target==="object"?e.target.id:e.target;
      if(s===d.id){ var n=DATA.nodes.find(function(x){return x.id===t}); if(n) related.push(n); }
      if(t===d.id){ var n2=DATA.nodes.find(function(x){return x.id===s}); if(n2) related.push(n2); }
    });
    if(related.length) {
      html += "<div class=\\"related-section\\"><h3>Connected Nodes ("+related.length+")</h3>";
      var grouped = {};
      related.forEach(function(r){ if(!grouped[r.type]) grouped[r.type]=[]; grouped[r.type].push(r); });
      var types = Object.keys(grouped);
      for(var ti=0; ti<types.length; ti++){
        var type = types[ti];
        var lc = COLORS[type] || COLORS[FIRST_TYPE];
        var items = grouped[type];
        for(var ii=0; ii<items.length; ii++){
          var item = items[ii];
          html += "<span class=\\"related-chip\\" data-node-id=\\""+escapeHtml(item.id)+"\\"";
          html += " style=\\"background:"+lc.bg+";border-color:"+lc.stroke+"40;color:"+lc.fill+"\\">";
          html += escapeHtml(item.label)+"</span>";
        }
      }
      html += "</div>";
    }
    html += "</div>";
    document.getElementById("detailContent").innerHTML = html;
    panel.classList.add("open");
    var chips = document.querySelectorAll(".related-chip");
    chips.forEach(function(chip){
      chip.addEventListener("click", function(){ focusNode(chip.getAttribute("data-node-id")); });
    });
  }

  function closePanel() { panel.classList.remove("open"); }

  function focusNode(id) {
    var n = DATA.nodes.find(function(x){return x.id===id});
    if(!n) return;
    showDetail(n);
    highlightConnected(n);
    var transform = d3.zoomTransform(svg.node());
    var tx = width/2 - n.x*transform.k;
    var ty = height/2 - n.y*transform.k;
    svg.transition().duration(500).call(zoomBehavior.transform, d3.zoomIdentity.translate(tx,ty).scale(transform.k));
  }

  node.on("mouseover", function(ev, d){
    var det = DATA.details[d.id] || {};
    var c = COLORS[d.type] || COLORS[FIRST_TYPE];
    var tip = "<strong style=\\"color:"+c.fill+"\\">"+escapeHtml(d.label)+"</strong>";
    var keys = Object.keys(det);
    for(var i=0; i<Math.min(keys.length,3); i++){
      if(keys[i]==="Type") continue;
      tip += "<br><span style=\\"color:#64748b\\">"+escapeHtml(keys[i])+":</span> "+escapeHtml(String(det[keys[i]]).substring(0,60));
    }
    tooltipEl.innerHTML = tip;
    tooltipEl.style.opacity = "1";
    tooltipEl.style.left = (ev.clientX+16)+"px";
    tooltipEl.style.top = (ev.clientY-10)+"px";
    highlightConnected(d);
  })
  .on("mousemove", function(ev){
    tooltipEl.style.left = (ev.clientX+16)+"px";
    tooltipEl.style.top = (ev.clientY-10)+"px";
  })
  .on("mouseout", function(){
    tooltipEl.style.opacity = "0";
    if(!activeFilter) clearHighlight();
  })
  .on("click", function(ev, d){
    ev.stopPropagation();
    if(wasDragged) return;
    showDetail(d);
  });

  svg.on("click", function(){ closePanel(); });

  document.getElementById("closeBtn").addEventListener("click", closePanel);
  document.getElementById("btnReset").addEventListener("click", function(){
    svg.transition().duration(600).call(zoomBehavior.transform, d3.zoomIdentity);
  });
  document.getElementById("btnLabels").addEventListener("click", function(){
    showLabels = !showLabels;
    this.classList.toggle("active");
    node.selectAll(".node-label").attr("opacity", showLabels?0.85:0);
  });

  var typeBtns = document.querySelectorAll(".controls button[data-type]");
  typeBtns.forEach(function(btn){
    btn.addEventListener("click", function(){ highlightType(btn.getAttribute("data-type")); });
  });
  document.getElementById("btnAll").addEventListener("click", clearHighlight);

  var filterNodes = DATA.nodes.filter(function(n){return n.type===FILTER_TYPE});
  var filterBar = document.getElementById("filterBar");
  var fc = COLORS[FILTER_TYPE] || COLORS[FIRST_TYPE];
  filterNodes.forEach(function(dn){
    var chip = document.createElement("div");
    chip.className = "filter-chip";
    chip.style.background = fc.bg;
    chip.style.borderColor = fc.stroke + "40";
    chip.style.color = fc.fill;
    chip.textContent = dn.label;
    chip.addEventListener("click", function(){ highlightConnected(dn); showDetail(dn); });
    filterBar.appendChild(chip);
  });

  simulation.on("tick", function(){
    link.attr("x1",function(d){return d.source.x}).attr("y1",function(d){return d.source.y})
        .attr("x2",function(d){return d.target.x}).attr("y2",function(d){return d.target.y});
    node.attr("transform", function(d){return "translate("+d.x+","+d.y+")"});
  });

  setTimeout(function(){
    var bounds = g.node().getBBox();
    if(bounds.width===0) return;
    var scale = Math.min(0.85, 0.85/Math.max(bounds.width/width, bounds.height/height));
    var tx = width/2 - scale*(bounds.x+bounds.width/2);
    var ty = height/2 - scale*(bounds.y+bounds.height/2);
    svg.transition().duration(800).call(zoomBehavior.transform, d3.zoomIdentity.translate(tx,ty).scale(scale));
  }, 2500);

})();
<\/script>
</body>
</html>`;

function buildHTML(data, titleOverride) {
  const config = data.config || {};
  const title = titleOverride || config.title || 'Knowledge Graph';
  const subtitle = config.subtitle || 'Drag nodes to rearrange · Click nodes for details · Scroll to zoom';
  const nodeTypes = config.nodeTypes || {};
  const edgeTypes = config.edgeTypes || {};
  const filterType = config.filterType || '';

  // Build COLORS JS object from config
  const colorsEntries = [];
  for (const [tkey, tconf] of Object.entries(nodeTypes)) {
    const c = tconf.color || '#60a5fa';
    const r = parseInt(c.slice(1, 3), 16);
    const g = parseInt(c.slice(3, 5), 16);
    const b = parseInt(c.slice(5, 7), 16);
    const bg = `rgba(${r},${g},${b},0.15)`;
    colorsEntries.push(`    ${JSON.stringify(tkey)}: {fill:"${c}", bg:"${bg}", stroke:"${c}"}`);
  }
  const colorsJs = '{\n' + colorsEntries.join(',\n') + '\n  }';

  // Build EDGE_COLORS, EDGE_WIDTHS, EDGE_DASH_SET
  const edgeColorsEntries = [];
  const edgeWidthEntries = [];
  const edgeDashEntries = [];
  for (const [ekey, econf] of Object.entries(edgeTypes)) {
    const ec = econf.color || 'rgba(100,116,139,0.15)';
    const ew = econf.width || 1.2;
    const ed = econf.dash || false;
    edgeColorsEntries.push(`    ${JSON.stringify(ekey)}: "${ec}"`);
    edgeWidthEntries.push(`    ${JSON.stringify(ekey)}: ${ew}`);
    if (ed) edgeDashEntries.push(JSON.stringify(ekey));
  }
  const edgeColorsJs = '{\n' + edgeColorsEntries.join(',\n') + '\n  }';
  const edgeWidthsJs = '{\n' + edgeWidthEntries.join(',\n') + '\n  }';
  const edgeDashSet = '[' + edgeDashEntries.join(', ') + ']';

  // Build legend HTML
  const legendItems = [];
  for (const [tkey, tconf] of Object.entries(nodeTypes)) {
    const c = tconf.color || '#60a5fa';
    const lbl = tconf.label || tkey;
    const r = parseInt(c.slice(1, 3), 16);
    const g = parseInt(c.slice(3, 5), 16);
    const b = parseInt(c.slice(5, 7), 16);
    const bg = `rgba(${r},${g},${b},0.2)`;
    legendItems.push(
      `<div class="legend-item"><div class="legend-dot" style="background:${bg};border-color:${c}"></div>${lbl}</div>`
    );
  }
  const legendHtml = legendItems.join('\n    ');

  // Build filter button HTML
  const typeButtons = [];
  for (const [tkey, tconf] of Object.entries(nodeTypes)) {
    const lbl = tconf.label || tkey;
    const btnId = 'btn_' + tkey.replace(/ /g, '_');
    typeButtons.push(`<button id="${btnId}" data-type="${tkey}">${lbl}</button>`);
  }
  const typeButtonsHtml = typeButtons.join('\n  ');

  // Node type keys
  const nodeTypeKeys = Object.keys(nodeTypes);
  const firstType = nodeTypeKeys[0] || '';

  // Radius lookup
  const radiusEntries = [];
  for (const [tkey, tconf] of Object.entries(nodeTypes)) {
    radiusEntries.push(`    ${JSON.stringify(tkey)}: ${tconf.radius || 16}`);
  }
  const radiusJs = '{\n' + radiusEntries.join(',\n') + '\n  }';

  // Label max lengths by type
  const labelMaxEntries = [];
  for (const tkey of nodeTypeKeys) {
    const r = nodeTypes[tkey].radius || 16;
    const mx = Math.max(12, Math.round(r * 1.2));
    labelMaxEntries.push(`    ${JSON.stringify(tkey)}: ${mx}`);
  }
  const labelMaxJs = '{\n' + labelMaxEntries.join(',\n') + '\n  }';

  // Graph data JSON
  const graphPayload = JSON.stringify({
    nodes: data.nodes || [],
    edges: data.edges || [],
    details: data.details || {}
  });

  // Filter type for chips
  const ft = filterType || firstType;

  let html = TEMPLATE;
  html = html.replace(/__TITLE__/g, title);
  html = html.replace(/__SUBTITLE__/g, subtitle);
  html = html.replace(/__LEGEND__/g, legendHtml);
  html = html.replace(/__TYPE_BUTTONS__/g, typeButtonsHtml);
  html = html.replace(/__GRAPH_DATA__/g, graphPayload);
  html = html.replace(/__COLORS_JS__/g, colorsJs);
  html = html.replace(/__EDGE_COLORS_JS__/g, edgeColorsJs);
  html = html.replace(/__EDGE_WIDTHS_JS__/g, edgeWidthsJs);
  html = html.replace(/__EDGE_DASH_SET__/g, edgeDashSet);
  html = html.replace(/__RADIUS_JS__/g, radiusJs);
  html = html.replace(/__LABEL_MAX_JS__/g, labelMaxJs);
  html = html.replace(/__FILTER_TYPE__/g, ft);
  html = html.replace(/__FIRST_TYPE__/g, firstType);

  return html;
}

// ─── Task 5: Main Workflow Orchestration ─────────────────────────────────────

(async () => {
  try {
    // Validate environment variables
    const missing = [];
    if (!FS_APP_ID) missing.push('FS_APP_ID');
    if (!FS_APP_SECRET) missing.push('FS_APP_SECRET');
    if (!BITABLE_APP_TOKEN) missing.push('BITABLE_APP_TOKEN');
    if (!PROJECT_TABLE_ID) missing.push('PROJECT_TABLE_ID');
    if (!CAPABILITY_TABLE_ID) missing.push('CAPABILITY_TABLE_ID');

    if (missing.length) {
      console.error(`缺少环境变量: ${missing.join(', ')}`);
      console.error('请检查 .env 文件或 GitHub Secrets');
      process.exit(1);
    }

    console.log('开始飞书数据同步与知识图谱生成...');

    // Step 1: Get tenant access token
    console.log('获取访问令牌...');
    const token = await getTenantAccessToken();
    console.log('令牌获取成功');

    // Step 2: Fetch data from Feishu
    const projects = await fetchProjects(token);
    const capabilities = await fetchCapabilities(token);

    // Step 3: Build relationships
    const relationships = buildRelationships(projects, capabilities);

    // Step 4: Generate graph config
    const graphConfig = generateGraphConfig(relationships);

    // Step 5: Generate HTML
    console.log('生成知识图谱 HTML...');
    const html = buildHTML(graphConfig);

    // Step 6: Save to file
    const outputDir = join(__dirname, '..', 'docs', 'dynamic');
    mkdirSync(outputDir, { recursive: true });
    const outputPath = join(outputDir, 'project-capability-graph.html');
    writeFileSync(outputPath, html, 'utf-8');

    console.log(`完成! ${graphConfig.nodes.length} 节点, ${graphConfig.edges.length} 关系`);
    console.log(`输出: ${outputPath} (${html.length} chars)`);
  } catch (err) {
    console.error('错误:', err.message);
    process.exit(1);
  }
})();
