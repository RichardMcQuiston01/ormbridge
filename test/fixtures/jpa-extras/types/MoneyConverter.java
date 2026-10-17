package extras.types;

import jakarta.persistence.AttributeConverter;
import jakarta.persistence.Converter;

@Converter
public class MoneyConverter implements AttributeConverter<Money, String> {
  @Override
  public String convertToDatabaseColumn(Money value) {
    return value == null ? null : value.getText();
  }

  @Override
  public Money convertToEntityAttribute(String text) {
    return text == null ? null : new Money(text);
  }
}
