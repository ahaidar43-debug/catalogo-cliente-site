SITE DO CATALOGO

Esta pasta ja esta pronta para publicar como site.

Antes de publicar:
1. Abra store-config.js.
2. Coloque o nome da loja e o WhatsApp que vai receber os pedidos.

Exemplo:
window.STORE_CONFIG = {
  name: "Minha Loja",
  whatsapp: "5599999999999",
  deliveryFee: 0
};

Como publicar:
- Netlify: arraste esta pasta ou o arquivo ZIP no painel "Add new site > Deploy manually".
- Vercel: importe esta pasta como projeto estatico.
- Hostinger/cPanel: envie todos os arquivos desta pasta para public_html.

Link do cliente:
- envie a URL principal do site, sem "?dono=1".

Modo dono:
- use a URL com "?dono=1" para ver historico local e baixar orcamento Excel.

Importante:
Esta versao envia o numero do pedido junto com os itens pelo WhatsApp.
Para consultar pedido apenas pelo numero em um painel online, precisa de banco de dados.
