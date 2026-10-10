<?php

declare(strict_types=1);

namespace App\Entity;

use DateTimeImmutable;
use Doctrine\Common\Collections\ArrayCollection;
use Doctrine\Common\Collections\Collection;
use Doctrine\ORM\Mapping as ORM;

#[ORM\Entity]
#[ORM\Table(name: 'blog_category')]
class BlogCategory
{
    #[ORM\Id]
    #[ORM\Column(name: 'id', type: 'guid')]
    private string $id;

    #[ORM\Column(
        name: 'created_at',
        type: 'datetimetz_immutable',
        options: ['default' => 'CURRENT_TIMESTAMP'],
    )]
    private DateTimeImmutable $createdAt;

    #[ORM\Column(name: 'updated_at', type: 'datetimetz_immutable')]
    private DateTimeImmutable $updatedAt;

    #[ORM\Column(name: 'name', type: 'string', length: 100, unique: true)]
    private string $name;

    #[ORM\Column(name: 'slug', type: 'string', length: 50)]
    private string $slug;

    #[ORM\ManyToOne(targetEntity: BlogCategory::class, inversedBy: 'blogCategories')]
    #[ORM\JoinColumn(
        name: 'parent_id',
        referencedColumnName: 'id',
        nullable: true,
        onDelete: 'SET NULL',
    )]
    private ?BlogCategory $parent = null;

    /** @var Collection<int, BlogCategory> */
    #[ORM\OneToMany(targetEntity: BlogCategory::class, mappedBy: 'parent')]
    private Collection $blogCategories;

    /** @var Collection<int, BlogPost> */
    #[ORM\OneToMany(targetEntity: BlogPost::class, mappedBy: 'category')]
    private Collection $blogPosts;

    public function __construct()
    {
        $this->id = self::generateUuid();
        $this->createdAt = new DateTimeImmutable();
        $this->blogCategories = new ArrayCollection();
        $this->blogPosts = new ArrayCollection();
    }

    public function getId(): string
    {
        return $this->id;
    }

    public function setId(string $id): static
    {
        $this->id = $id;

        return $this;
    }

    public function getCreatedAt(): DateTimeImmutable
    {
        return $this->createdAt;
    }

    public function setCreatedAt(DateTimeImmutable $createdAt): static
    {
        $this->createdAt = $createdAt;

        return $this;
    }

    public function getUpdatedAt(): DateTimeImmutable
    {
        return $this->updatedAt;
    }

    public function setUpdatedAt(DateTimeImmutable $updatedAt): static
    {
        $this->updatedAt = $updatedAt;

        return $this;
    }

    public function getName(): string
    {
        return $this->name;
    }

    public function setName(string $name): static
    {
        $this->name = $name;

        return $this;
    }

    public function getSlug(): string
    {
        return $this->slug;
    }

    public function setSlug(string $slug): static
    {
        $this->slug = $slug;

        return $this;
    }

    public function getParent(): ?BlogCategory
    {
        return $this->parent;
    }

    public function setParent(?BlogCategory $parent): static
    {
        $this->parent = $parent;

        return $this;
    }

    /**
     * @return Collection<int, BlogCategory>
     */
    public function getBlogCategories(): Collection
    {
        return $this->blogCategories;
    }

    public function addBlogCategory(BlogCategory $blogCategory): static
    {
        if (!$this->blogCategories->contains($blogCategory)) {
            $this->blogCategories->add($blogCategory);
            $blogCategory->setParent($this);
        }

        return $this;
    }

    public function removeBlogCategory(BlogCategory $blogCategory): static
    {
        if ($this->blogCategories->removeElement($blogCategory)) {
            if ($blogCategory->getParent() === $this) {
                $blogCategory->setParent(null);
            }
        }

        return $this;
    }

    /**
     * @return Collection<int, BlogPost>
     */
    public function getBlogPosts(): Collection
    {
        return $this->blogPosts;
    }

    public function addBlogPost(BlogPost $blogPost): static
    {
        if (!$this->blogPosts->contains($blogPost)) {
            $this->blogPosts->add($blogPost);
            $blogPost->setCategory($this);
        }

        return $this;
    }

    public function removeBlogPost(BlogPost $blogPost): static
    {
        if ($this->blogPosts->removeElement($blogPost)) {
            // The owning side is required, so it is not unset here.
        }

        return $this;
    }

    private static function generateUuid(): string
    {
        $bytes = random_bytes(16);
        $bytes[6] = chr((ord($bytes[6]) & 0x0f) | 0x40);
        $bytes[8] = chr((ord($bytes[8]) & 0x3f) | 0x80);

        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($bytes), 4));
    }
}
