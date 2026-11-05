# Acesso e operação

O serviço executa no Ubuntu do Dell, com Cockpit/PAM em loopback e conector Cloudflare systemd próprio. O notebook não serve o painel nem o túnel. O hostname Linux técnico e os IDs/caminhos da VM são preservados; o nome de apresentação é VPS Dell local.

Cloudflare Access exige o e-mail proprietário por OTP para humanos ou um service token exclusivo desta aplicação para automação. O Cockpit exige ainda o login PAM próprio. Credenciais ficam em private/ e no destino privado de entrega, nunca no Git. Token do túnel é credencial do conector; não é senha de usuário e não deve ser entregue como credencial geral de administração.

Procedimento por release: confira origem/CI, hashes e identidade; registre plano; aplique uma etapa; confira bind/serviço e o consumidor autenticado. Scripts planejam por padrão. PowerShell usa cmdlets nativos e Bash chama APT/systemd; Python orquestra a API com biblioteca padrão. Essas exceções a Rust evitam runtimes novos no bootstrap.

Retorno: remover primeiro a rota pública específica ou parar apenas vps-dell-cloudflared.service. Preservar dados, credenciais e recibos; não apagar a VM, Windows ou outras aplicações. Autostart da VM pode voltar ao valor capturado Nothing/delay0 usando seu ID. Exclusões Cloudflare exigem conferir os IDs privados desta operação; nunca alterar túnel/DNS de outro projeto.

Autostart configurado não prova recuperação após reinício do Windows. Disponibilidade exige Dell, energia e Internet ativos. Conector/cloudflare, autenticação PAM, terminal, acesso cloud e entrega WhatsApp têm provas separadas.
