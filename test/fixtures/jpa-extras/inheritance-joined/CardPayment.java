package extras.joined;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;

@Entity
public class CardPayment extends Payment {
  @Column(name = "card_number", nullable = false, length = 16)
  private String cardNumber;
}
