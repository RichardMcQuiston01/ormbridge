package extras.property;

import jakarta.persistence.Access;
import jakarta.persistence.AccessType;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;

// Explicit property access on a class whose @Id is on the getter as well.
@Entity
@Access(AccessType.PROPERTY)
public class Region {
  private Long id;
  private String code;

  @Id
  public Long getId() {
    return id;
  }

  public void setId(Long id) {
    this.id = id;
  }

  @Column(unique = true, length = 5)
  public String getCode() {
    return code;
  }

  public void setCode(String code) {
    this.code = code;
  }
}
