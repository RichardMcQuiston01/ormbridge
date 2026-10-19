package extras.embed;

import jakarta.persistence.Column;
import jakarta.persistence.Embeddable;

@Embeddable
public class Contact {
  @Column(name = "phone_number", length = 20)
  private String phone;

  private String email;
}
