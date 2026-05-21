# Catalogo Cliente

Site estatico para clientes montarem pedidos pelo catalogo e enviarem pelo WhatsApp.

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

## Publicar no Render

1. Suba este projeto para um repositorio no GitHub.
2. No Render, clique em `New > Static Site`.
3. Conecte o repositorio.
4. Use:
   - Build command: vazio
   - Publish directory: `.`

O arquivo `render.yaml` tambem esta pronto para Blueprint.

## Cliente

Envie para o cliente a URL principal do site.

O cliente escolhe produtos, preenche os dados e envia pelo WhatsApp. A mensagem vai com o numero do pedido, itens e total.

## Modo dono

Acesse com `?dono=1` no final da URL para mostrar recursos internos, como historico local e baixar Excel do orcamento.
