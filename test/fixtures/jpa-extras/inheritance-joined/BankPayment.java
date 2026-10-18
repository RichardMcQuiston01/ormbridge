package extras.joined;

import jakarta.persistence.Entity;
import jakarta.persistence.PrimaryKeyJoinColumn;

@Entity
@PrimaryKeyJoinColumn(name = "payment_id")
public class BankPayment extends Payment {
  private String iban;
}
