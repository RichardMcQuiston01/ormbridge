package extras.types;

/** A value object that is not an entity or an embeddable: it is stored through a converter. */
public class Money {
  private final String text;

  public Money(String text) {
    this.text = text;
  }

  public String getText() {
    return text;
  }
}
