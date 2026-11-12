'use strict';
const el=id=>document.getElementById(id);
const gib=n=>(n/1073741824).toLocaleString('pt-BR',{maximumFractionDigits:2})+' GiB';
const labels={'atendimento-piloto-chat-1':'Chatwoot · caixa da equipe','atendimento-piloto-worker-1':'Chatwoot · tarefas em segundo plano','atendimento-piloto-clock-1':'n8n · relógio e fluxos','atendimento-piloto-flow-1':'Langflow · fluxos de IA','atendimento-piloto-postgres-1':'PostgreSQL · dados','atendimento-piloto-redis-1':'Redis · fila e cache','jp-entrada-operacional':'Entrada de mensagens','jp-core-operacional':'Central de atendimento','jp-speech-dell':'Processamento de áudio','jp-core-transacional-dell':'Núcleo transacional','jp-core-dell':'Núcleo do piloto'};
const states={healthy:'Saudável',running:'Em execução',starting:'Iniciando',unhealthy:'Falha no teste interno',paused:'Pausado',restarting:'Reiniciando',exited:'Parado',dead:'Parado',created:'Criado, sem iniciar',missing:'Não encontrado'};
function rows(id,items){el(id).replaceChildren(...items.map(cells=>{const tr=document.createElement('tr');for(const value of cells){const td=document.createElement('td');td.textContent=value;tr.append(td);}return tr;}));}
async function read(){el('refresh').disabled=true;el('when').textContent='Consultando…';try{
const raw=await cockpit.spawn(['/usr/bin/python3','-I','/usr/local/share/cockpit/servicos-jp/read.py'],{superuser:'require',err:'message'});const d=JSON.parse(raw);
el('host').textContent=d.cores+' vCPUs · '+gib(d.avail)+' de '+gib(d.total)+' de RAM disponíveis · '+gib(d.disk.free)+' livres na raiz de '+gib(d.disk.total)+(d.disk.free/d.disk.total<.2?' · Atenção ao espaço livre':'');
rows('apps',d.apps.map(a=>[labels[a.name]||a.name,states[a.state]||a.state,a.cpu,a.mem,a.io]));
rows('units',d.units.map(a=>[a.name,a.state,a.mem]));el('when').textContent='Leitura: '+new Date(d.time*1000).toLocaleString('pt-BR',{timeZone:'America/Cuiaba'})+' (Cuiabá)';
}catch(e){el('host').textContent='Leitura indisponível.';rows('apps',[]);rows('units',[]);el('when').textContent='Confira a conexão e o Acesso administrativo do Cockpit.';}finally{el('refresh').disabled=false;}}
el('refresh').onclick=read;read();
