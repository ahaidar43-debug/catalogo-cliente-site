# Catalogo Cliente

Aplicativo web para clientes montarem pedidos pelo catalogo e enviarem pelo WhatsApp.
No Render ele roda com servidor Node e Postgres, guardando pedidos, usuarios e historico de downloads.

## Configuracao

Antes de publicar, edite `store-config.js`:

```js
window.STORE_CONFIG = {
  name: "Nome da sua loja",
  whatsapp: "5599999999999",
  deliveryFee: 0
};
```

Use o WhatsApp com DDI e DDD, somente numeros.

## Publicar no Render com banco

1. Suba este projeto para um repositorio no GitHub.
2. No Render, use `New > Blueprint`.
3. Conecte o repositorio.
4. O arquivo `render.yaml` cria:
   - Web Service Node `catalogo-cliente`
   - Postgres `catalogo-cliente-db`
   - Variavel `DATABASE_URL` ligada ao banco
   - `SESSION_SECRET` gerado automaticamente
5. Informe no painel do Render:
   - `ADMIN_PASSWORD`
   - `SELLER_PASSWORD`

Para teste local, o servidor usa um arquivo em `data/local-db.json`.

## Cliente

Envie para o cliente a URL principal do aplicativo no Render.

O cliente escolhe produtos, preenche os dados e envia pelo WhatsApp. A mensagem vai com numero do pedido, itens, total e link interno para a vendedora abrir direto o pedido.

## Modo vendedora/admin

Acesse com `?dono=1` no final da URL.

No modo vendedora:

- Nao aparece catalogo.
- Nao aparece carrinho.
- Aparece login e senha.
- Depois do login, aparecem os pedidos realizados.
- Se acessar pelo link do WhatsApp, cai direto no pedido.
- Ao baixar Excel, o sistema registra quem baixou e quando.

O admin tambem pode criar usuarios e ver o historico de cada pedido.

## Logins iniciais

Localmente, se nenhuma senha estiver configurada:

- Admin: `admin` / `admin123`
- Vendedora: `vendedora` / `vendedora123`

No Render, configure senhas reais nas variaveis `ADMIN_PASSWORD` e `SELLER_PASSWORD`.
