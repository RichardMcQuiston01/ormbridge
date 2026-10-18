package extras.keys;

import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.MapsId;
import jakarta.persistence.OneToOne;

// A shared primary key: the id of PersonDetail is the foreign key to Person.
@Entity
public class PersonDetail {
  @Id private Long id;

  @MapsId
  @OneToOne
  @JoinColumn(name = "id")
  private Person person;

  private String nickname;
}
