<?php

declare(strict_types=1);

namespace App\Entity;

use Doctrine\Common\Collections\ArrayCollection;
use Doctrine\Common\Collections\Collection;
use Doctrine\ORM\Mapping as ORM;

#[ORM\Entity]
#[ORM\Table(name: 'blog_tag')]
class BlogTag
{
    #[ORM\Id]
    #[ORM\GeneratedValue(strategy: 'AUTO')]
    #[ORM\Column(name: 'id', type: 'integer')]
    private ?int $id = null;

    #[ORM\Column(name: 'label', type: 'string', length: 50)]
    private string $label;

    /** @var Collection<int, BlogPost> */
    #[ORM\ManyToMany(targetEntity: BlogPost::class, mappedBy: 'tags')]
    private Collection $blog_posts;

    public function __construct()
    {
        $this->blog_posts = new ArrayCollection();
    }

    public function getId(): ?int
    {
        return $this->id;
    }

    public function getLabel(): string
    {
        return $this->label;
    }

    public function setLabel(string $label): static
    {
        $this->label = $label;

        return $this;
    }

    /**
     * @return Collection<int, BlogPost>
     */
    public function getBlogPosts(): Collection
    {
        return $this->blog_posts;
    }

    public function addBlogPost(BlogPost $blogPost): static
    {
        if (!$this->blog_posts->contains($blogPost)) {
            $this->blog_posts->add($blogPost);
            $blogPost->addTag($this);
        }

        return $this;
    }

    public function removeBlogPost(BlogPost $blogPost): static
    {
        if ($this->blog_posts->removeElement($blogPost)) {
            $blogPost->removeTag($this);
        }

        return $this;
    }
}
