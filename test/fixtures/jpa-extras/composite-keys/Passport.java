package extras.keys;

import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.OneToOne;

// A derived identity: the relationship itself is the id.
@Entity
public class Passport {
  @Id
  @OneToOne
  @JoinColumn(name = "person_id")
  private Person holder;

  private String number;
}
