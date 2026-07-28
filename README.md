# Rate Your Library

Avalie sua biblioteca do Spotify: veja todos os álbuns salvos, entre em cada um
para ver as faixas, marcar como ouvido e dar uma nota de 1 a 5 estrelas.

Segue o mesmo estilo visual do [Spotify Shuffle](https://thbertolino.github.io/spotify_shuffle/).
100% estático (GitHub Pages) — sem servidor.

## Funcionalidades

- Login com Spotify (Authorization Code + PKCE, direto do navegador).
- **Artistas**: todos os artistas com álbum salvo, em ordem alfabética, com busca e paginação.
- **Página do artista**: álbuns salvos daquele artista.
- **Detalhe do álbum**: capa, faixas (com indicação de quais já estão na sua
  Liked Songs, e permite curtir/descurtir direto), toggle "já ouvi" e nota de 1 a 5 estrelas.
- **Avaliações**: lista de álbuns já ouvidos e/ou avaliados.

As notas e o status "ouvido" ficam salvos no **Firestore** (Firebase), por
usuário (ID do Spotify) — sincronizado na nuvem, não depende só do navegador.

## Setup

### 1. Criar o app no Spotify

1. Acesse https://developer.spotify.com/dashboard e crie um app.
2. Em **Redirect URIs**, adicione a URL onde o app vai rodar — por exemplo:
   - `https://SEU_USUARIO.github.io/rate_your_library/` (produção)
   - `http://127.0.0.1:5500/` (teste local, se usar `npx serve docs`)
3. Marque **Web API** em "Which API/SDKs are you planning to use?".
4. Copie o **Client ID** e cole na constante `CLIENT_ID` em [docs/app.js](docs/app.js).

### 2. Criar o projeto no Firebase

1. Acesse https://console.firebase.google.com, crie um projeto.
2. Vá em **Build → Firestore Database → Criar banco de dados** (modo de teste
   é só o ponto de partida — veja as regras abaixo).
3. Em **Configurações do projeto → Seus apps**, registre um app Web (`</>`).
4. Copie o objeto `firebaseConfig` e cole em [docs/app.js](docs/app.js), na
   constante `firebaseConfig` (já está preenchido com um projeto de exemplo —
   troque pelo seu).

### 3. Definir as regras de segurança do Firestore

No console do Firebase, em **Firestore Database → Regras**, substitua pelo conteúdo:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /ratings/{docId} {
      allow read, write: if true;
    }
  }
}
```

> ⚠️ Isso deixa a coleção `ratings` aberta para qualquer um que tenha a
> configuração pública do Firebase (a mesma exposta no `app.js`). Não tem
> autenticação real por trás — é o mesmo nível de segurança do restante do
> app (tokens do Spotify guardados só no navegador). Aceitável para um
> projeto pessoal, mas não guarde nada sensível nessa coleção.
>
> Diferente do modo de teste padrão do Firebase, essas regras **não expiram**
> — não esqueça de trocar pelo conteúdo acima antes de publicar.

### 4. Testar localmente (opcional)

```bash
npx serve docs -l 5500
```

Acesse `http://127.0.0.1:5500/` (lembre de cadastrar essa URL como Redirect
URI no Spotify também).

## Deploy no GitHub Pages

1. Suba este repositório para o GitHub.
2. Em **Settings → Pages**, em "Build and deployment", escolha **Deploy from
   a branch**, branch `main`, pasta **`/docs`**.
3. Aguarde alguns minutos — o GitHub publica em
   `https://SEU_USUARIO.github.io/rate_your_library/`.
4. Confirme que essa URL exata está cadastrada como Redirect URI no
   [Spotify Dashboard](https://developer.spotify.com/dashboard) (passo 1 acima).

## Estrutura

```
docs/index.html   -> shell da SPA (login / artistas / álbum / avaliações) — servido pelo GitHub Pages
docs/app.js       -> lógica: auth PKCE, chamadas à API do Spotify, Firestore, UI
docs/styles.css   -> visual (mesma paleta do Spotify Shuffle)
```

## Próximos passos

- Integrar com o Spotify Shuffle (sortear álbum ainda não avaliado, por exemplo).
- Filtros na tela de Avaliações (por nota, por ouvidos/não ouvidos).
- Ordenar biblioteca por nota, data de adição, etc.
