package models

// Category uses 32-bit integer keys like the other canonical fixtures, so the
// key fields are int32 (GORM maps int32 to serial; a plain uint or int would
// become bigserial).
type Category struct {
	TimeStamped
	ID       int32  `gorm:"primaryKey"`
	Name     string `gorm:"size:100;not null;unique"`
	Slug     string `gorm:"size:50;not null"`
	ParentID *int32
	Parent   *Category  `gorm:"foreignKey:ParentID"`
	Children []Category `gorm:"foreignKey:ParentID;constraint:OnDelete:SET NULL"`
}

func (Category) TableName() string { return "blog_category" }
