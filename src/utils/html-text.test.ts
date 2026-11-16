import { decodeHtmlEntities, htmlToPlainText, textToHtml } from './html-text.js';

describe('htmlToPlainText', () => {
  it('turns paragraphs and line breaks into lines', () => {
    expect(htmlToPlainText('<p>Bonjour,</p><p>Ligne 1<br>Ligne 2</p>')).toBe(
      'Bonjour,\n\nLigne 1\nLigne 2',
    );
  });

  it('collapses HTML whitespace outside <pre>', () => {
    expect(htmlToPlainText('<div>un\n   deux\t trois</div>')).toBe('un deux trois');
  });

  it('keeps <pre> content verbatim', () => {
    expect(htmlToPlainText('<pre>a  b\n  c</pre>')).toBe('a  b\n  c');
  });

  it('keeps the link target next to its text', () => {
    expect(htmlToPlainText('<a href="https://example.com/doc">la doc</a>')).toBe(
      // Même notation qu'à la lecture (moteur html-to-text partagé).
      'la doc [https://example.com/doc]',
    );
    // Texte identique à la cible : pas de doublon.
    expect(htmlToPlainText('<a href="https://example.com">https://example.com</a>')).toBe(
      'https://example.com',
    );
    expect(htmlToPlainText('<a href="mailto:a@b.fr">a@b.fr</a>')).toBe('a@b.fr');
  });

  it('renders lists, images with alt and drops style/script/comments', () => {
    const html =
      '<style>p{color:red}</style><script>alert(1)</script><!-- note -->' +
      '<ul><li>un</li><li>deux</li></ul><img src="cid:logo" alt="Logo"><img src="x.png">';
    expect(htmlToPlainText(html)).toBe('- un\n- deux\n\n[Logo]');
  });

  it('quotes <blockquote> content with ">" (nested included)', () => {
    const html =
      '<p>Réponse</p><blockquote><p>cité</p><blockquote>très cité</blockquote></blockquote>';
    // Le « > » seul sépare le paragraphe cité de la citation imbriquée ;
    // html-to-text préfixe chaque niveau par « > » (« > > »).
    expect(htmlToPlainText(html)).toBe('Réponse\n\n> cité\n>\n> > très cité');
  });

  it('decodes entities, French accents included', () => {
    expect(htmlToPlainText('&Eacute;t&eacute; &amp; caf&#233; &#x2014; &nbsp;fin')).toBe(
      // L'espace insécable est conservée (U+00A0) et ne fusionne pas avec
      // l'espace voisine, comme dans un navigateur.
      'Été & café —  fin',
    );
  });
});

describe('decodeHtmlEntities / textToHtml', () => {
  it('leaves unknown entities untouched', () => {
    expect(decodeHtmlEntities('&inconnu; &lt;')).toBe('&inconnu; <');
  });

  it('escapes text and converts line breaks', () => {
    expect(textToHtml('a < b\nc & d')).toBe('a &lt; b<br>c &amp; d');
  });
});
